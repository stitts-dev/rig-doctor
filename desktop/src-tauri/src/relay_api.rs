//! Client for the relay control API (relay/api.py): join a relay with a one-time invite, refresh
//! the saved config when the relay's game prefix list changes, read health, and leave.
//!
//! The WireGuard keypair is made here with `wg genkey`, so the private key never leaves this
//! machine: the relay only gets the public key and serves configs with a placeholder in its place.
//! The invite pins the relay's self-signed TLS certificate (the only root trusted for that API)
//! and its WireGuard key, and every config the API returns must carry that same key.

use crate::relay::{self, RelaySummary, TunnelState, WgConfig};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

pub const INVITE_PREFIX: &str = "rigrelay1.";
pub const PLACEHOLDER: &str = "<client private key>";
const MAX_INVITE: usize = 8 * 1024;
/// How long Connect waits for a config refresh before going on with the saved one.
pub const CONNECT_REFRESH_TIMEOUT: Duration = Duration::from_secs(3);
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Invite {
    pub v: u32,
    pub name: String,
    pub api: String,
    /// The API's TLS certificate, base64 DER.
    pub cert: String,
    pub relay_key: String,
    pub secret: String,
    #[serde(default)]
    pub expires: u64,
}

/// What a joined relay keeps beside its saved config: how to reach its API and this device's token.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApiMeta {
    pub api: String,
    pub cert: String,
    pub relay_key: String,
    pub token: String,
    pub prefix_version: String,
}

#[derive(Debug, Deserialize)]
struct ConfigResponse {
    config: String,
    prefix_version: String,
    #[serde(default)]
    token: Option<String>,
    /// Game server /24s the relay's players have seen (relays from before this list send none).
    #[serde(default)]
    game_prefixes: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct RefreshResult {
    pub name: String,
    /// The relay's prefix list differs from the saved config's.
    pub changed: bool,
    /// The new config is in the tunnel's config. False while that relay's tunnel is on: it applies
    /// at the next refresh with the tunnel off (Connect does one).
    pub applied: bool,
    pub prefix_version: String,
}

fn valid_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 32 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub fn parse_invite(text: &str) -> Result<Invite, String> {
    let t = text.trim();
    if t.len() > MAX_INVITE {
        return Err("That invite is too long.".into());
    }
    let blob = t.strip_prefix(INVITE_PREFIX).ok_or("That is not a Rig Doctor relay invite (it should start with rigrelay1.).")?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(blob.trim_end_matches('=')).map_err(|_| "The invite is damaged (bad encoding). Copy it again.".to_string())?;
    let inv: Invite = serde_json::from_slice(&bytes).map_err(|_| "The invite is damaged (bad contents). Copy it again.".to_string())?;
    if inv.v != 1 {
        return Err(format!("This invite is version {}; update Rig Doctor.", inv.v));
    }
    let url = reqwest::Url::parse(&inv.api).map_err(|_| "The invite's relay address is not valid.".to_string())?;
    if url.scheme() != "https" || url.host().is_none() || url.path() != "/" || url.query().is_some() || !url.username().is_empty() {
        return Err("The invite's relay address is not valid.".into());
    }
    if !relay::valid_key(&inv.relay_key) {
        return Err("The invite's relay key is not a WireGuard key.".into());
    }
    if inv.secret.len() != 43 || !inv.secret.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err("The invite's secret is damaged. Copy it again.".into());
    }
    if !valid_name(&inv.name) {
        return Err("The invite's player name is not valid.".into());
    }
    cert_der(&inv.cert)?;
    if inv.expires != 0 && inv.expires < relay::now_ms() / 1000 {
        return Err("This invite has expired. Ask for a new one.".into());
    }
    Ok(inv)
}

fn cert_der(b64: &str) -> Result<Vec<u8>, String> {
    let der = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "The relay certificate is damaged.".to_string())?;
    if der.len() < 100 || der.len() > 4096 || der[0] != 0x30 {
        return Err("The relay certificate is damaged.".into());
    }
    Ok(der)
}

/// Puts this device's private key into a config the API served, then checks it the same way an
/// import is checked. The relay's key must be the one the invite pinned.
pub fn fill_key(config: &str, private_key: &str, relay_key: &str) -> Result<WgConfig, String> {
    if !relay::valid_key(private_key) {
        return Err("The device's WireGuard key is not valid.".into());
    }
    let mut seen = false;
    let text: String = config
        .lines()
        .map(|l| {
            let (k, v) = l.split_once('=').map(|(k, v)| (k.trim(), v.trim())).unwrap_or(("", ""));
            if k.eq_ignore_ascii_case("PrivateKey") && v == PLACEHOLDER {
                seen = true;
                format!("PrivateKey = {private_key}")
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !seen {
        return Err("The relay sent a config without the key placeholder; refusing it.".into());
    }
    let cfg = relay::parse_config(&text)?;
    if cfg.public_key != relay_key {
        return Err("The relay's key does not match the invite. Not saving this config.".into());
    }
    Ok(cfg)
}

/// A WireGuard keypair from `wg genkey` and `wg pubkey`.
pub fn keygen() -> Result<(String, String), String> {
    let wg = relay::find_tools().wg.ok_or_else(|| relay::missing_message().to_string())?;
    let run = |args: &[&str], input: Option<&str>| -> Result<String, String> {
        let mut child = crate::cmd(&wg.to_string_lossy()).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("wg: {e}"))?;
        if let Some(i) = input {
            child.stdin.take().unwrap().write_all(i.as_bytes()).map_err(|e| format!("wg: {e}"))?;
        }
        drop(child.stdin.take());
        let out = child.wait_with_output().map_err(|e| format!("wg: {e}"))?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !out.status.success() || !relay::valid_key(&s) {
            return Err("wg could not make a key.".into());
        }
        Ok(s)
    };
    let private = run(&["genkey"], None)?;
    let public = run(&["pubkey"], Some(&private))?;
    Ok((private, public))
}

// ---------- HTTP ----------

fn client(cert_b64: &str, timeout: Duration) -> Result<reqwest::Client, String> {
    let cert = reqwest::Certificate::from_der(&cert_der(cert_b64)?).map_err(|e| format!("Relay certificate: {e}"))?;
    reqwest::Client::builder()
        .use_rustls_tls()
        // Only the relay's own certificate is trusted for its API.
        .tls_built_in_root_certs(false)
        .add_root_certificate(cert)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Relay API client: {e}"))
}

enum Method {
    Get,
    Post(serde_json::Value),
    Delete,
}

/// One API call. Returns the status and the parsed body (Null when empty).
fn call(api: &str, cert: &str, token: Option<&str>, method: Method, path: &str, timeout: Duration) -> Result<(u16, serde_json::Value), String> {
    let c = client(cert, timeout)?;
    let url = format!("{}{path}", api.trim_end_matches('/'));
    tauri::async_runtime::block_on(async move {
        let mut req = match method {
            Method::Get => c.get(&url),
            Method::Post(body) => c.post(&url).json(&body),
            Method::Delete => c.delete(&url),
        };
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let r = req.send().await.map_err(|e| format!("Could not reach the relay API: {e}"))?;
        let status = r.status().as_u16();
        let bytes = r.bytes().await.map_err(|e| format!("Relay API: {e}"))?;
        if bytes.len() > 256 * 1024 {
            return Err("Relay API answer is too large.".to_string());
        }
        let v = if bytes.is_empty() { serde_json::Value::Null } else { serde_json::from_slice(&bytes).map_err(|_| "Relay API sent something that is not JSON.".to_string())? };
        Ok((status, v))
    })
}

fn api_error(status: u16, body: &serde_json::Value) -> String {
    let msg = body.get("error").and_then(|e| e.as_str()).unwrap_or("request failed");
    match status {
        401 => "The relay no longer accepts this device (revoked or removed). Ask for a new invite.".into(),
        _ => format!("Relay API ({status}): {msg}"),
    }
}

fn ok_json<T: for<'de> Deserialize<'de>>(r: (u16, serde_json::Value)) -> Result<T, String> {
    let (status, body) = r;
    if status != 200 {
        return Err(api_error(status, &body));
    }
    serde_json::from_value(body).map_err(|_| "Relay API answer is missing fields.".to_string())
}

// ---------- storage ----------

pub fn meta_path(dir: &Path, id: &str) -> PathBuf {
    relay::saved_dir(dir).join(format!("{id}.api.json"))
}

pub fn load_meta(dir: &Path, id: &str) -> Result<Option<ApiMeta>, String> {
    match std::fs::read_to_string(meta_path(dir, id)) {
        Ok(s) => serde_json::from_str(&s).map(Some).map_err(|e| format!("Relay {id} API settings: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Relay {id} API settings: {e}")),
    }
}

fn store_meta(dir: &Path, id: &str, m: &ApiMeta) -> Result<(), String> {
    let text = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    relay::write_private_file(&meta_path(dir, id), text.as_bytes())
}

/// The saved relay `name`, or the tunnel's relay when None.
fn resolve(dir: &Path, name: Option<&str>) -> Result<relay::SavedRelay, String> {
    let relays = relay::list(dir)?;
    let id = match name {
        Some(n) => n.to_string(),
        None => relay::active_id(dir, &relays)?.ok_or("No relay is selected.")?,
    };
    relays.into_iter().find(|r| r.id == id).ok_or_else(|| format!("No saved relay named {id}."))
}

// ---------- operations ----------

/// Joins a relay with an invite: makes this device's key, enrolls its public key, and saves the
/// config like an import (it becomes the tunnel's relay). NAME defaults to the invite's name.
pub fn join_blocking(dir: &Path, invite: &str, name: Option<&str>) -> Result<RelaySummary, String> {
    let inv = parse_invite(invite)?;
    if relay::tunnel_state(dir) != TunnelState::Down {
        return Err("Turn the relay off before joining a new one.".into());
    }
    let (private, public) = keygen()?;
    let body = serde_json::json!({ "invite": inv.secret, "public_key": public });
    let resp: ConfigResponse = ok_json(call(&inv.api, &inv.cert, None, Method::Post(body), "/v1/enroll", CALL_TIMEOUT)?)?;
    let token = resp.token.clone().ok_or("Relay API did not return a device token.")?;
    let saved = fill_key(&resp.config, &private, &inv.relay_key).and_then(|cfg| {
        let summary = relay::import_blocking(dir, &relay::render_config(&cfg), Some(name.unwrap_or(&inv.name)))?;
        let id = relay::relay_id(Some(name.unwrap_or(&inv.name)), &cfg);
        store_meta(dir, &id, &ApiMeta { api: inv.api.clone(), cert: inv.cert.clone(), relay_key: inv.relay_key.clone(), token: token.clone(), prefix_version: resp.prefix_version.clone() })?;
        Ok(summary)
    });
    if saved.is_err() {
        // Don't leave a peer on the relay that nothing here can use.
        let _ = call(&inv.api, &inv.cert, Some(&token), Method::Delete, "/v1/peer", CALL_TIMEOUT);
    }
    saved
}

/// Fetches the relay's current config. When its prefix version changed, rewrites the saved config
/// with this device's key kept, and the tunnel's config too when that relay is selected and off.
pub fn refresh_blocking(dir: &Path, name: Option<&str>, timeout: Duration) -> Result<RefreshResult, String> {
    let r = resolve(dir, name)?;
    let mut meta = load_meta(dir, &r.id)?.ok_or_else(|| format!("{} was imported from a file, not joined with an invite; it has no relay API.", r.id))?;
    let resp: ConfigResponse = ok_json(call(&meta.api, &meta.cert, Some(&meta.token), Method::Get, "/v1/config", timeout)?)?;
    share_ranges(dir, &meta, &resp.game_prefixes, timeout);
    if resp.prefix_version == meta.prefix_version {
        return Ok(RefreshResult { name: r.id, changed: false, applied: true, prefix_version: meta.prefix_version });
    }
    let cfg = fill_key(&resp.config, &r.cfg.private_key, &meta.relay_key)?;
    relay::save_relay(dir, &r.id, &cfg)?;
    let active = relay::active_id(dir, &relay::list(dir)?)?.as_deref() == Some(r.id.as_str());
    let applied = if active {
        if relay::tunnel_state(dir) == TunnelState::Down {
            relay::store(dir, &crate::game_ranges::effective(dir, &cfg))?;
            true
        } else {
            false
        }
    } else {
        true
    };
    if applied {
        meta.prefix_version = resp.prefix_version.clone();
        store_meta(dir, &r.id, &meta)?;
    }
    Ok(RefreshResult { name: r.id, changed: true, applied, prefix_version: resp.prefix_version })
}

/// Takes the relay's shared game ranges, and sends it the ones this device saw in matches that it
/// doesn't list yet. Best effort: a relay without the list (older API) or a failed call changes
/// nothing, and the next refresh tries again.
fn share_ranges(dir: &Path, meta: &ApiMeta, listed: &[String], timeout: Duration) {
    if let Err(e) = crate::game_ranges::merge_relay(dir, listed, relay::now_ms()) {
        eprintln!("game ranges: {e}");
    }
    let missing = unlisted(&crate::game_ranges::from_matches(dir), listed);
    if missing.is_empty() {
        return;
    }
    let body = serde_json::json!({ "prefixes": missing });
    if let Err(e) = call(&meta.api, &meta.cert, Some(&meta.token), Method::Post(body), "/v1/servers", timeout) {
        eprintln!("game ranges: report skipped: {e}");
    }
}

/// Own ranges the relay doesn't list, at most 16 (the API's limit per call).
fn unlisted(own: &[String], listed: &[String]) -> Vec<String> {
    own.iter().filter(|r| !listed.contains(r)).take(16).cloned().collect()
}

/// Before Connect or On: refresh a joined relay so new game prefixes go through the tunnel.
/// Never blocks the connection: a relay API that is down or slow leaves the saved config as is.
pub fn refresh_before_connect(dir: &Path, id: Option<&str>) {
    let Ok(r) = resolve(dir, id) else { return };
    if !matches!(load_meta(dir, &r.id), Ok(Some(_))) {
        return;
    }
    if let Err(e) = refresh_blocking(dir, Some(&r.id), CONNECT_REFRESH_TIMEOUT) {
        eprintln!("relay {}: config refresh skipped: {e}", r.id);
    }
}

/// The relay's health as its API reports it: tunnel up, peer count, prefix version, and this
/// device's last handshake and bytes.
pub fn health_blocking(dir: &Path, name: Option<&str>) -> Result<serde_json::Value, String> {
    let r = resolve(dir, name)?;
    let meta = load_meta(dir, &r.id)?.ok_or_else(|| format!("{} has no relay API (imported from a file).", r.id))?;
    let (status, body) = call(&meta.api, &meta.cert, Some(&meta.token), Method::Get, "/v1/health", CALL_TIMEOUT)?;
    if status != 200 {
        return Err(api_error(status, &body));
    }
    let mut body = body;
    if let Some(o) = body.as_object_mut() {
        o.insert("name".into(), serde_json::Value::String(r.id));
        o.insert("prefix_current".into(), serde_json::Value::Bool(o.get("prefix_version").and_then(|v| v.as_str()) == Some(meta.prefix_version.as_str())));
    }
    Ok(body)
}

/// Removes this device's peer from the relay, then the saved relay here. A relay that already
/// revoked the device counts as left.
pub fn leave_blocking(dir: &Path, name: Option<&str>) -> Result<(), String> {
    let r = resolve(dir, name)?;
    let meta = load_meta(dir, &r.id)?.ok_or_else(|| format!("{} has no relay API (imported from a file).", r.id))?;
    let active = relay::active_id(dir, &relay::list(dir)?)?.as_deref() == Some(r.id.as_str());
    if active && relay::tunnel_state(dir) != TunnelState::Down {
        return Err("Turn the relay off before leaving it.".into());
    }
    let (status, body) = call(&meta.api, &meta.cert, Some(&meta.token), Method::Delete, "/v1/peer", CALL_TIMEOUT)?;
    if status != 204 && status != 401 {
        return Err(api_error(status, &body));
    }
    if active {
        relay::remove_blocking(dir)?;
    } else {
        relay::remove_saved(dir, &r.id)?;
    }
    match std::fs::remove_file(meta_path(dir, &r.id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELAY: &str = "cGxhY2Vob2xkZXJwbGFjZWhvbGRlcnBsYWNlaG9sZGU=";
    const DEVICE: &str = "ZGV2aWNla2V5ZGV2aWNla2V5ZGV2aWNla2V5ZGV2aWM=";

    fn cert() -> String {
        let mut der = vec![0x30u8, 0x82];
        der.extend(std::iter::repeat_n(7u8, 300));
        base64::engine::general_purpose::STANDARD.encode(der)
    }

    fn invite_json(v: serde_json::Value) -> String {
        format!("{INVITE_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string()))
    }

    fn good() -> serde_json::Value {
        serde_json::json!({"v": 1, "name": "alice", "api": "https://198.51.100.1:51821", "cert": cert(), "relay_key": RELAY, "secret": "A".repeat(43), "expires": 0})
    }

    fn served() -> String {
        format!("# Rig Doctor relay client: alice\n[Interface]\nPrivateKey = {PLACEHOLDER}\nAddress = 10.66.66.2/32\n\n[Peer]\nPublicKey = {RELAY}\nEndpoint = 198.51.100.1:51820\nAllowedIPs = 10.66.66.1/32, 198.51.100.0/24\nPersistentKeepalive = 25\n")
    }

    #[test]
    fn parses_a_good_invite() {
        let inv = parse_invite(&format!("  {}\n", invite_json(good()))).unwrap();
        assert_eq!(inv.name, "alice");
        assert_eq!(inv.api, "https://198.51.100.1:51821");
        assert_eq!(inv.relay_key, RELAY);
    }

    #[test]
    fn refuses_bad_invites() {
        assert!(parse_invite("hello").unwrap_err().contains("rigrelay1."));
        assert!(parse_invite("rigrelay1.!!!").unwrap_err().contains("encoding"));
        let bad = |k: &str, v: serde_json::Value| {
            let mut j = good();
            j[k] = v;
            parse_invite(&invite_json(j)).unwrap_err()
        };
        assert!(bad("v", 2.into()).contains("version 2"));
        for api in ["http://198.51.100.1:51821", "https://198.51.100.1:51821/x", "https://u@198.51.100.1:1", "nope"] {
            assert!(bad("api", api.into()).contains("address"), "{api}");
        }
        assert!(bad("relay_key", "short".into()).contains("relay key"));
        assert!(bad("secret", "x".into()).contains("secret"));
        assert!(bad("name", "Bad Name".into()).contains("name"));
        assert!(bad("cert", "AAAA".into()).contains("certificate"));
        assert!(bad("expires", 1.into()).contains("expired"));
    }

    #[test]
    fn fills_the_device_key_and_pins_the_relay_key() {
        let cfg = fill_key(&served(), DEVICE, RELAY).unwrap();
        assert_eq!(cfg.private_key, DEVICE);
        assert_eq!(cfg.public_key, RELAY);
        let other = "b3RoZXJyZWxheW90aGVycmVsYXlvdGhlcnJlbGF5b3Q=";
        assert!(fill_key(&served(), DEVICE, other).unwrap_err().contains("does not match"));
    }

    #[test]
    fn refuses_a_config_that_brings_its_own_key() {
        let with_key = served().replace(PLACEHOLDER, DEVICE);
        assert!(fill_key(&with_key, DEVICE, RELAY).unwrap_err().contains("placeholder"));
        assert!(fill_key(&served(), "nope", RELAY).is_err());
    }

    #[test]
    fn served_configs_get_import_checks() {
        let full = served().replace("10.66.66.1/32, 198.51.100.0/24", "0.0.0.0/0");
        assert!(fill_key(&full, DEVICE, RELAY).is_err());
        let hook = served().replace("Address = 10.66.66.2/32", "Address = 10.66.66.2/32\nPostUp = calc.exe");
        assert!(fill_key(&hook, DEVICE, RELAY).is_err());
    }

    fn tmp() -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("rd-api-{}-{}-{n}", std::process::id(), relay::now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn meta_round_trips_privately() {
        let d = tmp();
        let m = ApiMeta { api: "https://198.51.100.1:51821".into(), cert: cert(), relay_key: RELAY.into(), token: "t".into(), prefix_version: "v1".into() };
        store_meta(&d, "alice", &m).unwrap();
        assert_eq!(load_meta(&d, "alice").unwrap(), Some(m));
        assert_eq!(load_meta(&d, "bob").unwrap(), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(meta_path(&d, "alice")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // The saved-relay list reads only .conf files, so the API file is not a relay.
        assert!(relay::list(&d).unwrap().is_empty());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn reports_only_ranges_the_relay_lacks() {
        let own: Vec<String> = (0..20).map(|i| format!("198.51.{i}.0/24")).collect();
        let listed = vec!["198.51.0.0/24".to_string()];
        let m = unlisted(&own, &listed);
        assert_eq!(m.len(), 16);
        assert!(!m.contains(&"198.51.0.0/24".to_string()));
        assert!(unlisted(&listed, &listed).is_empty());
    }

    #[test]
    fn config_response_without_game_list_still_reads() {
        let r: ConfigResponse = serde_json::from_value(serde_json::json!({"config": "x", "prefix_version": "v"})).unwrap();
        assert!(r.game_prefixes.is_empty());
    }

    #[test]
    fn refresh_needs_a_joined_relay() {
        let d = tmp();
        let cfg = fill_key(&served(), DEVICE, RELAY).unwrap();
        relay::save_relay(&d, "filed", &cfg).unwrap();
        assert!(refresh_blocking(&d, Some("filed"), CONNECT_REFRESH_TIMEOUT).unwrap_err().contains("imported from a file"));
        assert!(refresh_blocking(&d, Some("missing"), CONNECT_REFRESH_TIMEOUT).unwrap_err().contains("No saved relay"));
        std::fs::remove_dir_all(d).unwrap();
    }
}
