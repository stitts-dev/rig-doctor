//! Relay tunnel: imports a WireGuard client config from `rig-relay-add-peer`, keeps it in the app
//! data folder readable only by this user (and SYSTEM on Windows, which runs the tunnel service),
//! brings the tunnel up and down with the stock WireGuard tools, reports its state, and measures
//! latency to the relay and to a game server with and without the tunnel.
//!
//! Imported configs are rewritten from a small allowlist of keys. Hook keys (PostUp and friends)
//! would run commands as admin, and DNS or a default route would push all traffic through the
//! relay, so those configs are refused rather than trimmed.

use crate::{cmd, PingStats};
use serde::Serialize;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// Interface and Windows service suffix. wg-quick names the interface after the file.
pub const TUNNEL: &str = "rigrelay";
pub const CONF_FILE: &str = "rigrelay.conf";

/// One up/down/compare at a time: each can raise an admin prompt and changes routes.
static BUSY: Mutex<()> = Mutex::new(());

#[path = "wgconf.rs"]
mod wgconf;
pub use wgconf::*;

fn is_private_v4(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || (v.octets()[0] == 100 && (64..128).contains(&v.octets()[1])),
        IpAddr::V6(_) => false,
    }
}

/// The relay's own tunnel address: the first private /32 in AllowedIPs (10.66.66.1 from
/// rig-relay-add-peer). Pinging it measures the client-to-relay leg through the tunnel.
pub fn probe_addr(c: &WgConfig) -> Option<IpAddr> {
    c.allowed_ips.iter().find(|a| a.len == 32 && is_private_v4(&a.addr)).map(|a| a.addr)
}

pub fn routes_via_tunnel(c: &WgConfig, ip: &IpAddr) -> bool {
    c.allowed_ips.iter().any(|a| a.contains(ip))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RelaySummary {
    /// The saved relay's name.
    pub name: Option<String>,
    pub endpoint: String,
    pub address: String,
    /// First 8 characters of the relay's public key, enough to tell configs apart.
    pub peer_key: String,
    pub allowed_ips: usize,
    pub probe: Option<String>,
    pub keepalive: Option<u16>,
}

pub fn summarize(c: &WgConfig) -> RelaySummary {
    summarize_named(c, None)
}

pub fn summarize_named(c: &WgConfig, name: Option<&str>) -> RelaySummary {
    RelaySummary {
        name: name.map(str::to_string),
        endpoint: format!("{}:{}", c.endpoint_host, c.endpoint_port),
        address: c.address.iter().map(Cidr::to_string).collect::<Vec<_>>().join(", "),
        peer_key: c.public_key.chars().take(8).collect(),
        allowed_ips: c.allowed_ips.len(),
        probe: probe_addr(c).map(|a| a.to_string()),
        keepalive: c.keepalive,
    }
}

// ---------- storage ----------

pub fn conf_path(dir: &Path) -> PathBuf {
    dir.join("relay").join(CONF_FILE)
}

pub fn load(dir: &Path) -> Result<Option<WgConfig>, String> {
    match std::fs::read_to_string(conf_path(dir)) {
        Ok(s) => parse_config(&s).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Reading the relay config: {e}")),
    }
}

/// Writes the config so only this user can read it. The file is written beside the target and
/// renamed over it, so a crash never leaves half a key on disk.
pub fn store(dir: &Path, c: &WgConfig) -> Result<PathBuf, String> {
    store_at(&conf_path(dir), c)
}

fn store_at(path: &Path, c: &WgConfig) -> Result<PathBuf, String> {
    write_private_file(path, render_config(c).as_bytes())?;
    Ok(path.to_path_buf())
}

/// Writes a file only this user can read, beside the target first and renamed over it.
pub(crate) fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let folder = path.parent().unwrap();
    std::fs::create_dir_all(folder).map_err(|e| format!("Creating {}: {e}", folder.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = folder.join(format!("{name}.tmp"));
    write_private(&tmp, bytes)?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Saving the relay config: {e}"))?;
    #[cfg(windows)]
    restrict_windows(path)?;
    Ok(())
}

// ---------- saved relays ----------
//
// Every imported relay is kept in `relay/saved/<name>.conf` so Auto can try each one. The tunnel
// always runs from `relay/rigrelay.conf` (the Windows service and wg-quick are set up for that
// file), so picking a relay copies its config there while the tunnel is down.

#[derive(Clone, Debug, PartialEq)]
pub struct SavedRelay {
    /// File stem: the name given at import, or `relay-` and the start of the relay's key.
    pub id: String,
    pub cfg: WgConfig,
}

pub fn saved_dir(dir: &Path) -> PathBuf {
    dir.join("relay").join("saved")
}

/// Lowercase letters, digits and dashes, at most 32. Empty, or "direct" (the direct path's id),
/// falls back to a name from the relay's key.
pub fn relay_id(name: Option<&str>, c: &WgConfig) -> String {
    let raw: String = name.unwrap_or("").trim().to_ascii_lowercase().chars().map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' }).collect();
    let mut id = raw.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    id.truncate(32);
    let id = id.trim_end_matches('-').to_string();
    if id.is_empty() || id == "direct" {
        let key: String = c.public_key.chars().filter(|ch| ch.is_ascii_alphanumeric()).take(8).collect::<String>().to_ascii_lowercase();
        format!("relay-{key}")
    } else {
        id
    }
}

fn saved_file(dir: &Path, id: &str) -> PathBuf {
    saved_dir(dir).join(format!("{id}.conf"))
}

/// Saved relays read from disk, sorted by name.
fn read_saved(dir: &Path) -> Result<Vec<SavedRelay>, String> {
    let mut out = Vec::new();
    match std::fs::read_dir(saved_dir(dir)) {
        Ok(entries) => {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("conf") {
                    continue;
                }
                let id = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let text = std::fs::read_to_string(&p).map_err(|e| format!("Reading saved relay {id}: {e}"))?;
                let cfg = parse_config(&text).map_err(|e| format!("Saved relay {id}: {e}"))?;
                out.push(SavedRelay { id, cfg });
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Reading saved relays: {e}")),
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Saved relays sorted by name. An active config from before relays were saved is listed first.
pub fn list(dir: &Path) -> Result<Vec<SavedRelay>, String> {
    let mut out = read_saved(dir)?;
    if let Some(active) = load(dir)? {
        if !out.iter().any(|r| r.cfg.public_key == active.public_key) {
            out.insert(0, SavedRelay { id: relay_id(None, &active), cfg: active });
        }
    }
    Ok(out)
}

/// The relay the tunnel config is, matched by the relay's public key.
pub fn active_id(dir: &Path, relays: &[SavedRelay]) -> Result<Option<String>, String> {
    Ok(load(dir)?.and_then(|a| relays.iter().find(|r| r.cfg.public_key == a.public_key).map(|r| r.id.clone())))
}

/// Saves `c` under `id`, dropping a copy of the same relay saved under another name.
pub(crate) fn save_relay(dir: &Path, id: &str, c: &WgConfig) -> Result<(), String> {
    save(dir, id, c)
}

/// Deletes saved relay `id` (not the tunnel's config).
pub(crate) fn remove_saved(dir: &Path, id: &str) -> Result<(), String> {
    match std::fs::remove_file(saved_file(dir, id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn save(dir: &Path, id: &str, c: &WgConfig) -> Result<(), String> {
    for other in read_saved(dir).unwrap_or_default() {
        if other.id != id && other.cfg.public_key == c.public_key {
            let _ = std::fs::remove_file(saved_file(dir, &other.id));
        }
    }
    store_at(&saved_file(dir, id), c).map(|_| ())
}

/// Points the tunnel at a saved relay. The tunnel has to be down: a running tunnel keeps the
/// config it started with. The tunnel runs the relay's config narrowed to known game ranges
/// (game_ranges::effective, not on Windows); the saved copy keeps the relay's full list.
pub fn activate(dir: &Path, id: &str) -> Result<(), String> {
    let relays = list(dir)?;
    let r = relays.iter().find(|r| r.id == id).ok_or_else(|| format!("No saved relay named {id}."))?;
    if active_id(dir, &relays)?.as_deref() == Some(id) {
        return Ok(());
    }
    if tunnel_state(dir) != TunnelState::Down {
        return Err("Turn the relay off before switching relays.".into());
    }
    store(dir, &crate::game_ranges::effective(dir, &r.cfg)).map(|_| ())
}

/// With the tunnel down: rewrites the tunnel's config when the game ranges it should carry
/// changed since it was written (a range learned in a match, or the picked game changed). A config
/// not saved as a relay is left as is. Returns whether it was rewritten.
pub fn sync_active(dir: &Path) -> Result<bool, String> {
    let Some(cur) = load(dir)? else { return Ok(false) };
    let Some(saved) = read_saved(dir)?.into_iter().find(|r| r.cfg.public_key == cur.public_key) else { return Ok(false) };
    let want = crate::game_ranges::effective(dir, &saved.cfg);
    if want == cur {
        return Ok(false);
    }
    store(dir, &want)?;
    Ok(true)
}

/// Puts the tunnel on saved relay `id`: turns off another relay that is on, makes `id` the
/// tunnel's relay, and turns it on. With `guard`, refused in a game; the app's Connect passes false
/// because the user asked for it.
pub fn connect_blocking(dir: &Path, id: &str, guard: bool) -> Result<(), String> {
    let relays = list(dir)?;
    if !relays.iter().any(|r| r.id == id) {
        return Err(format!("No saved relay named {id}."));
    }
    if active_id(dir, &relays)?.as_deref() != Some(id) && tunnel_state(dir) != TunnelState::Down {
        if guard {
            guard_game(dir)?;
        }
        set_tunnel(dir, false)?;
    }
    // A relay joined by invite: pick up new game prefixes first (best effort, short timeout).
    crate::relay_api::refresh_before_connect(dir, Some(id));
    activate(dir, id)?;
    set_tunnel_with(dir, true, guard)
}

#[derive(Serialize, Clone, Debug)]
pub struct SavedSummary {
    pub active: bool,
    #[serde(flatten)]
    pub summary: RelaySummary,
}

pub fn list_summaries(dir: &Path) -> Result<Vec<SavedSummary>, String> {
    let relays = list(dir)?;
    let active = active_id(dir, &relays)?;
    Ok(relays.iter().map(|r| SavedSummary { active: active.as_deref() == Some(r.id.as_str()), summary: summarize_named(&r.cfg, Some(&r.id)) }).collect())
}

#[cfg(unix)]
fn write_private(p: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if let Some(d) = p.parent() {
        let _ = std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700));
    }
    let _ = std::fs::remove_file(p);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(p).map_err(|e| format!("Saving the relay config: {e}"))?;
    f.write_all(bytes).map_err(|e| format!("Saving the relay config: {e}"))
}

#[cfg(not(unix))]
fn write_private(p: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(p, bytes).map_err(|e| format!("Saving the relay config: {e}"))
}

/// Drops inherited access and grants only this user, SYSTEM (the tunnel service) and Administrators.
#[cfg(windows)]
fn restrict_windows(p: &Path) -> Result<(), String> {
    let user = std::env::var("USERNAME").map_err(|_| "USERNAME is not set".to_string())?;
    let out = cmd("icacls")
        .arg(p)
        .args(["/inheritance:r", "/grant:r", &format!("{user}:F"), "*S-1-5-18:F", "*S-1-5-32-544:F"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("icacls: {e}"))?;
    if !out.status.success() {
        return Err(format!("Could not restrict access to the relay config: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

#[path = "relay_windows.rs"]
pub mod winsvc;

// ---------- WireGuard tools ----------

#[derive(Clone, Debug, Default)]
pub struct Tools {
    /// wireguard.exe, Windows only.
    pub manager: Option<PathBuf>,
    pub wg: Option<PathBuf>,
    /// wg-quick, macOS and Linux.
    pub quick: Option<PathBuf>,
}

pub fn find_in(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(name)).find(|p| p.is_file())
}

/// Where wg and wg-quick are looked for: Homebrew's wireguard-tools first (Apple silicon, then
/// Intel), then PATH, then the system folders a Linux package installs to.
pub fn unix_tool_dirs(path: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from).to_vec();
    dirs.extend(path.map(|p| std::env::split_paths(p).collect::<Vec<_>>()).unwrap_or_default());
    dirs.extend(["/usr/bin", "/bin", "/usr/sbin"].map(PathBuf::from));
    dirs
}

pub fn find_tools() -> Tools {
    if cfg!(windows) {
        let mut dirs: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432"].iter().filter_map(std::env::var_os).map(|p| PathBuf::from(p).join("WireGuard")).collect();
        dirs.push(PathBuf::from(r"C:\Program Files\WireGuard"));
        Tools { manager: find_in(&dirs, "wireguard.exe"), wg: find_in(&dirs, "wg.exe"), quick: None }
    } else {
        let dirs = unix_tool_dirs(std::env::var_os("PATH").as_deref());
        Tools { manager: None, wg: find_in(&dirs, "wg"), quick: find_in(&dirs, "wg-quick") }
    }
}

pub fn missing_message() -> &'static str {
    if cfg!(windows) {
        "WireGuard is not installed. Install it from https://www.wireguard.com/install/ and try again."
    } else if cfg!(target_os = "macos") {
        "WireGuard tools are not installed. Run `brew install wireguard-tools` and try again."
    } else {
        "WireGuard tools are not installed. Install the wireguard-tools package and try again."
    }
}

pub(crate) fn installed(t: &Tools) -> bool {
    if cfg!(windows) {
        t.manager.is_some()
    } else {
        t.quick.is_some() && t.wg.is_some()
    }
}

// ---------- tunnel state ----------

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelState {
    Down,
    Starting,
    Up,
    Stopping,
    /// Partly up: some of the tunnel's routes or its process remain. Off clears it.
    Degraded,
}

/// State number from `sc query`: 1 stopped, 2 start pending, 3 stop pending, 4 running. The
/// number is read instead of the word after it, which some Windows languages translate.
pub fn parse_sc_state(text: &str) -> Option<TunnelState> {
    let line = text.lines().find(|l| l.trim_start().starts_with("STATE"))?;
    let n: String = line.split_once(':')?.1.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    Some(match n.parse::<u32>().ok()? {
        2 => TunnelState::Starting,
        3 => TunnelState::Stopping,
        4 => TunnelState::Up,
        _ => TunnelState::Down,
    })
}

/// Interface named on the `interface:` line of macOS `route -n get` output.
pub fn parse_route_iface(text: &str) -> Option<&str> {
    text.lines().find_map(|l| l.trim().strip_prefix("interface:")).map(str::trim)
}

/// First address of the first AllowedIPs range that isn't the relay's own: a game server range.
pub fn game_addr(c: &WgConfig) -> Option<IpAddr> {
    let probe = probe_addr(c);
    c.allowed_ips.iter().find(|a| a.addr.is_ipv4() && Some(a.addr) != probe).map(|a| a.addr)
}

/// Up when the relay's address routes through a utun. Degraded when only a game range does, or
/// wireguard-go still runs: game traffic may still go through a broken tunnel, so it never reads
/// as down.
pub fn mac_state(probe_iface: Option<&str>, game_iface: Option<&str>, wg_go: bool) -> TunnelState {
    let utun = |i: Option<&str>| i.is_some_and(|i| i.starts_with("utun"));
    if utun(probe_iface) {
        TunnelState::Up
    } else if utun(game_iface) || wg_go {
        TunnelState::Degraded
    } else {
        TunnelState::Down
    }
}

fn wireguard_go_running() -> bool {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes().values().any(|p| p.name().to_string_lossy() == "wireguard-go")
}

/// The game the guard watches when the app config names none.
pub const DEFAULT_GAME: &str = "League of Legends";

/// The game process picked in the app (config.json `game`), League when unset. The CLI reads the
/// same file, so the terminal and the app guard the same game.
pub fn game_name(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("game")?.as_str().map(|g| g.trim().to_string()))
        .filter(|g| !g.is_empty())
        .unwrap_or_else(|| DEFAULT_GAME.into())
}

fn norm_process(name: &str) -> String {
    let n = name.trim().to_ascii_lowercase();
    n.strip_suffix(".exe").unwrap_or(&n).to_string()
}

/// Whether process `name` is `game` running. For League that is the match itself, not the
/// launcher or LeagueClient. macOS can cut names to 15 or 16 characters ("League of Legend").
pub fn is_game_process(name: &str, game: &str) -> bool {
    let (n, g) = (norm_process(name), norm_process(game));
    if g.starts_with("league of legend") {
        return n.starts_with("league of legend");
    }
    !n.is_empty() && (n == g || (n.len() >= 15 && g.starts_with(&n)))
}

pub fn game_running(game: &str) -> Option<String> {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes().values().map(|p| p.name().to_string_lossy().into_owned()).find(|n| is_game_process(n, game))
}

/// The League client's lockfile: `name:pid:port:password:protocol`. Returns the port and password
/// of its local API.
pub fn parse_lockfile(text: &str) -> Option<(u16, String)> {
    let f: Vec<&str> = text.trim().split(':').collect();
    if f.len() != 5 || f[3].is_empty() {
        return None;
    }
    Some((f[2].parse().ok()?, f[3].to_string()))
}

/// What the guard calls a client phase that a route change could hit: from the ready check until
/// the game is over. The game process only appears at the loading screen, so these cover the gap.
pub fn phase_blocks(phase: &str) -> Option<&'static str> {
    Some(match phase {
        "ReadyCheck" => "at a ready check",
        "ChampSelect" => "in champ select",
        "GameStart" => "starting a game",
        "InProgress" => "in a game",
        "Reconnect" => "reconnecting to a game",
        _ => return None,
    })
}

/// The League client's gameflow phase ("Lobby", "ChampSelect", ...) from its local API on
/// 127.0.0.1. None when the client isn't running or doesn't answer within a second.
pub fn client_phase() -> Option<String> {
    let lock = crate::league_install_dirs().into_iter().flat_map(|d| [d.join("lockfile"), d.join("Contents").join("LoL").join("lockfile")]).find_map(|p| std::fs::read_to_string(p).ok())?;
    let (port, password) = parse_lockfile(&lock)?;
    tauri::async_runtime::block_on(async move {
        // The client serves its API on loopback with a self-signed certificate.
        let client = reqwest::Client::builder().danger_accept_invalid_certs(true).timeout(Duration::from_secs(1)).build().ok()?;
        let r = client.get(format!("https://127.0.0.1:{port}/lol-gameflow/v1/gameflow-phase")).basic_auth("riot", Some(password)).send().await.ok()?;
        if !r.status().is_success() {
            return None;
        }
        r.json::<String>().await.ok()
    })
}

/// Changing routes mid-match can drop the game connection, so the tunnel never changes in a game,
/// and for League also from the ready check on (the game process only appears at the loading screen).
/// Auto and the CLI (which threads use) refuse then. The app's own On and Connect only warn: the
/// user decides, see [`game_warning`].
pub(crate) fn guard_game(dir: &Path) -> Result<(), String> {
    match game_busy(dir) {
        Some((game, what)) => Err(format!("{game} is {what}. Change the relay after the match so the game connection isn't dropped.")),
        None => Ok(()),
    }
}

/// What the app says after the user switched the tunnel mid-match: it happens, with a warning.
pub(crate) fn game_warning(dir: &Path) -> Option<String> {
    game_busy(dir).map(|(game, what)| format!("Switched while {game} is {what}. If the game drops, reconnect from the client."))
}

/// The picked game and what it is doing, when a route change could drop it.
fn game_busy(dir: &Path) -> Option<(String, &'static str)> {
    let game = game_name(dir);
    if game_running(&game).is_some() {
        return Some((game, "in a game"));
    }
    if !game.to_ascii_lowercase().starts_with("league of legend") {
        return None;
    }
    let what = client_phase().as_deref().and_then(phase_blocks)?;
    Some((game, what))
}

pub fn tunnel_state(dir: &Path) -> TunnelState {
    if cfg!(windows) {
        let svc = format!("WireGuardTunnel${TUNNEL}");
        // Exit code 1060 means no such service: the tunnel was never installed or was removed.
        cmd("sc").args(["query", &svc]).stderr(Stdio::null()).output().ok().and_then(|o| parse_sc_state(&String::from_utf8_lossy(&o.stdout))).unwrap_or(TunnelState::Down)
    } else if cfg!(target_os = "macos") {
        // wg-quick's /var/run/wireguard is root-only, so ask the routing table and the process
        // list instead: the relay's address and a game range should both route through a utun.
        let cfg = load(dir).ok().flatten();
        let iface = |ip: Option<IpAddr>| {
            let ip = ip?.to_string();
            let out = cmd("route").args(["-n", "get", &ip]).stderr(Stdio::null()).output().ok()?;
            parse_route_iface(&String::from_utf8_lossy(&out.stdout)).map(str::to_string)
        };
        let probe = cfg.as_ref().and_then(probe_addr);
        let game = cfg.as_ref().and_then(game_addr);
        mac_state(iface(probe).as_deref(), iface(game).as_deref(), wireguard_go_running())
    } else if Path::new(&format!("/sys/class/net/{TUNNEL}")).exists() {
        TunnelState::Up
    } else {
        TunnelState::Down
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WgPeer {
    pub public_key: String,
    pub endpoint: Option<String>,
    pub allowed_ips: Vec<String>,
    /// Unix seconds, None before the first handshake.
    pub latest_handshake: Option<u64>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub keepalive: Option<u16>,
}

/// Peers from `wg show <iface> dump`. The first line is the interface (private key, public key,
/// listen port, fwmark) and is skipped. Each peer line has eight tab-separated fields:
/// public key, preshared key, endpoint, allowed IPs, latest handshake, rx, tx, keepalive.
pub fn parse_wg_dump(text: &str) -> Result<Vec<WgPeer>, String> {
    let none = |s: &str| if s == "(none)" || s == "off" || s.is_empty() { None } else { Some(s.to_string()) };
    let mut peers = Vec::new();
    for line in text.lines().skip(1).filter(|l| !l.trim().is_empty()) {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() != 8 {
            return Err(format!("unexpected wg show line with {} fields", f.len()));
        }
        let int = |s: &str| s.trim().parse::<u64>().map_err(|_| format!("bad number \"{s}\" in wg show output"));
        let hs = int(f[4])?;
        peers.push(WgPeer {
            public_key: f[0].to_string(),
            endpoint: none(f[2]),
            allowed_ips: none(f[3]).map(|s| s.split(',').map(|x| x.to_string()).collect()).unwrap_or_default(),
            latest_handshake: (hs > 0).then_some(hs),
            rx_bytes: int(f[5])?,
            tx_bytes: int(f[6])?,
            keepalive: none(f[7]).map(|s| s.parse::<u16>().map_err(|_| format!("bad keepalive \"{s}\""))).transpose()?,
        });
    }
    Ok(peers)
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Serialize, Clone, Debug)]
pub struct RelayStatus {
    pub installed: bool,
    pub imported: bool,
    /// The tunnel's relay, by saved name.
    pub name: Option<String>,
    /// Relays saved for Auto, the tunnel's included.
    pub saved: u32,
    pub state: TunnelState,
    pub endpoint: Option<String>,
    pub handshake_age_s: Option<u64>,
    pub rx_bytes: Option<u64>,
    pub tx_bytes: Option<u64>,
    /// One echo to the relay's tunnel address when the handshake can't be read. A reply proves a
    /// handshake in the last 3 minutes, since WireGuard drops traffic on an older session.
    pub probe_ms: Option<f64>,
    /// Why a field is empty, or what to do next.
    pub detail: Option<String>,
    /// League's client phase when a route change could hit it ("in champ select"), so the app can
    /// say so before the game process exists. None for other games or when the client is closed.
    pub client_phase: Option<&'static str>,
    /// What the picked game is doing when a route change could drop it ("in a game", "in champ
    /// select"), from the process list and League's client phase. None when it isn't playing.
    pub game_state: Option<&'static str>,
    /// Set only on the answer to the app's On or Connect when it switched mid-match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

pub fn status(dir: &Path) -> RelayStatus {
    let tools = find_tools();
    let cfg = load(dir);
    let relays = list(dir).unwrap_or_default();
    let mut s = RelayStatus {
        installed: installed(&tools),
        imported: matches!(cfg, Ok(Some(_))),
        name: active_id(dir, &relays).ok().flatten(),
        saved: relays.len() as u32,
        state: TunnelState::Down,
        endpoint: cfg.as_ref().ok().and_then(|c| c.as_ref()).map(|c| format!("{}:{}", c.endpoint_host, c.endpoint_port)),
        handshake_age_s: None,
        rx_bytes: None,
        tx_bytes: None,
        probe_ms: None,
        detail: None,
        client_phase: if game_name(dir).to_ascii_lowercase().starts_with("league of legend") { client_phase().as_deref().and_then(phase_blocks) } else { None },
        game_state: None,
        warning: None,
    };
    // The game process itself, not only processes with open connections: League's game socket is
    // unconnected UDP, so the connection list can miss it.
    s.game_state = if game_running(&game_name(dir)).is_some() { Some("in a game") } else { s.client_phase };
    if let Err(e) = &cfg {
        s.detail = Some(e.clone());
        return s;
    }
    if !s.installed {
        s.detail = Some(missing_message().into());
        return s;
    }
    s.state = tunnel_state(dir);
    if s.state == TunnelState::Degraded {
        s.detail = Some("The tunnel is partly up and game traffic may still use it. Press Off to clear it.".into());
    }
    if s.state != TunnelState::Up {
        return s;
    }
    let Some(wg) = tools.wg else { return s };
    // Reading tunnel internals needs admin on every OS; without it the latency probe is the check.
    let out = cmd(&wg.to_string_lossy()).args(["show", TUNNEL, "dump"]).stdout(Stdio::piped()).stderr(Stdio::null()).output();
    match out.ok().filter(|o| o.status.success()).map(|o| parse_wg_dump(&String::from_utf8_lossy(&o.stdout))) {
        Some(Ok(peers)) => {
            if let Some(p) = peers.first() {
                s.handshake_age_s = p.latest_handshake.map(|t| now_s().saturating_sub(t));
                s.rx_bytes = Some(p.rx_bytes);
                s.tx_bytes = Some(p.tx_bytes);
            }
        }
        Some(Err(e)) => s.detail = Some(e),
        None => {
            s.probe_ms = cfg.ok().flatten().as_ref().and_then(probe_addr).and_then(|p| ping_once(&p.to_string()));
            s.detail = Some(match s.probe_ms {
                Some(_) => "Handshake time needs admin rights; the relay reply shows the tunnel works.".into(),
                None => "Relay did not answer through the tunnel.".into(),
            });
        }
    }
    s
}

// ---------- up / down ----------

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// PowerShell that runs `exe args` elevated (one UAC prompt), waits, and exits with its code.
/// A declined prompt exits 1223, Windows' "operation cancelled".
pub fn ps_elevate_script(exe: &str, args: &str) -> String {
    format!(
        "$ErrorActionPreference='Stop'; try {{ $p = Start-Process -FilePath {} -ArgumentList {} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode }} catch {{ [Console]::Error.WriteLine($_.Exception.Message); exit 1223 }}",
        ps_quote(exe),
        ps_quote(args)
    )
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Root shell line for macOS or Linux. Down falls back to removing the interface directly
/// (on macOS, deleting wireguard-go's socket makes it exit and take the utun with it), so Off works
/// even when an earlier start half failed. Up clears any such leftover first.
pub fn unix_line(quick: &str, verb: &str, conf: &str, macos: bool) -> String {
    let (q, c) = (sh_quote(quick), sh_quote(conf));
    let fallback = if macos { format!("rm -f /var/run/wireguard/{TUNNEL}.sock /var/run/wireguard/{TUNNEL}.name") } else { format!("ip link del {TUNNEL}") };
    let down = format!("{q} down {c} || {fallback}");
    let line = if verb == "up" { format!("{{ {down}; }} >/dev/null 2>&1; {q} up {c}") } else { down };
    if macos {
        format!("PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; {line}")
    } else {
        line
    }
}

/// AppleScript that runs a shell line with the macOS admin password prompt.
pub fn osascript_line(sh: &str) -> String {
    format!("do shell script \"{}\" with administrator privileges", sh.replace('\\', "\\\\").replace('"', "\\\""))
}

/// One admin prompt per change. macOS first tries the privileged helper (mac_helper.rs), which asks
/// for nothing once allowed. Otherwise macOS and Linux run the package manager's wg-quick behind
/// the system prompt. Windows uses it for Off when `sc stop` is not allowed.
fn run_admin(tools: &Tools, verb: &str, conf: &Path) -> Result<(), String> {
    let conf = conf.to_string_lossy().into_owned();
    if cfg!(windows) {
        let exe = tools.manager.as_ref().ok_or(missing_message())?.to_string_lossy().into_owned();
        // Up never comes here on Windows: turn_on installs from the protected copy.
        let args = format!("/uninstalltunnelservice {TUNNEL}");
        let out = cmd("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &ps_elevate_script(&exe, &args)]).output();
        return admin_result(out, &format!("WireGuard {verb}"));
    }
    #[cfg(target_os = "macos")]
    if let Some(r) = crate::mac_helper::run(verb, Path::new(&conf)) {
        return r;
    }
    let quick = tools.quick.as_ref().ok_or(missing_message())?.to_string_lossy().into_owned();
    run_root_line(&unix_line(&quick, verb, &conf, cfg!(target_os = "macos")))
}

fn wait_for(dir: &Path, want: TunnelState, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if tunnel_state(dir) == want {
            return true;
        }
        if start.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

pub(crate) fn set_tunnel(dir: &Path, up: bool) -> Result<(), String> {
    set_tunnel_with(dir, up, true)
}

/// `guard` false skips the in-game refusal for On: the app's own toggle, where the user decides.
pub(crate) fn set_tunnel_with(dir: &Path, up: bool, guard: bool) -> Result<(), String> {
    let tools = find_tools();
    if !installed(&tools) {
        return Err(missing_message().into());
    }
    if !up {
        // Off always runs, whatever the state reads, so a half-started tunnel can be cleared. It is
        // allowed mid-game too: it is the way out when the relay makes a match worse.
        let ran = turn_off(&tools, &conf_path(dir));
        if wait_for(dir, TunnelState::Down, Duration::from_secs(15)) {
            return match ran {
                Err(e) if e.starts_with("Admin approval") => Err(e),
                _ => Ok(()),
            };
        }
        return Err(ran.err().unwrap_or_else(|| "The tunnel did not go down within 15 s.".into()));
    }
    let state = tunnel_state(dir);
    if state == TunnelState::Up {
        return Ok(());
    }
    if guard {
        guard_game(dir)?;
    }
    if load(dir)?.is_none() {
        return Err("Import a relay config first.".into());
    }
    if state == TunnelState::Down {
        // Game ranges learned since the config was written go in now, never into a running tunnel.
        // Windows keeps the full list, so this changes nothing there and On stays prompt-free.
        sync_active(dir)?;
    }
    turn_on(&tools, &conf_path(dir))?;
    if !wait_for(dir, TunnelState::Up, Duration::from_secs(15)) {
        return Err("The tunnel did not come up within 15 s. Press Off to clear anything it left behind.".into());
    }
    Ok(())
}

// ---------- elevation ----------

/// Maps an admin step's result: a declined prompt, a failure with its message, or success.
fn admin_result(out: std::io::Result<std::process::Output>, what: &str) -> Result<(), String> {
    let out = out.map_err(|e| format!("Starting {what}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    // 1223: UAC declined. 126: pkexec dismissed. osascript reports "User canceled" (-128).
    if matches!(out.status.code(), Some(1223) | Some(126)) || err.contains("-128") {
        return Err("Admin approval was declined, so the tunnel was not changed.".into());
    }
    Err(if err.is_empty() { format!("{what} failed (exit {:?}).", out.status.code()) } else { format!("{what} failed: {err}") })
}

/// One shell line as root behind the system admin prompt (macOS, Linux).
fn run_root_line(line: &str) -> Result<(), String> {
    let out = if cfg!(target_os = "macos") {
        cmd("osascript").args(["-e", &osascript_line(line)]).output()
    } else {
        cmd("pkexec").args(["/bin/sh", "-c", line]).output()
    };
    admin_result(out, "WireGuard")
}

/// Windows: no prompt when the tunnel service is set up and its protected copy matches the saved
/// config. Otherwise the first On, or the first after the config changed, copies, sets up and
/// starts in one UAC prompt. macOS and Linux: wg-quick up behind the admin prompt.
fn turn_on(tools: &Tools, conf: &Path) -> Result<(), String> {
    if cfg!(windows) {
        let saved = std::fs::read(conf).map_err(|e| format!("Reading the relay config: {e}"))?;
        let copy = std::fs::read(winsvc::protected_conf(&winsvc::program_data())).ok();
        if !winsvc::needs_setup(&saved, copy.as_deref()) && winsvc::windows_sc("start")? {
            return Ok(());
        }
        let manager = tools.manager.as_ref().ok_or(missing_message())?.to_string_lossy().into_owned();
        let sid = winsvc::windows_sid();
        let ps = winsvc::windows_install_ps(&manager, &saved, sid.as_deref());
        let args = format!("-NoProfile -NonInteractive -EncodedCommand {}", winsvc::ps_encoded(&ps));
        let out = cmd("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &ps_elevate_script("powershell.exe", &args)]).output();
        return admin_result(out, "WireGuard setup");
    }
    run_admin(tools, "up", conf)
}

/// Windows: `sc stop` without a prompt when set up. Otherwise, and on macOS and Linux, the prompted
/// teardown, which also clears a half-started tunnel.
fn turn_off(tools: &Tools, conf: &Path) -> Result<(), String> {
    if cfg!(windows) && winsvc::windows_sc("stop")? {
        return Ok(());
    }
    run_admin(tools, "down", conf)
}

// ---------- latency ----------

/// One echo with a 1 s timeout. None means lost.
pub fn ping_once(host: &str) -> Option<f64> {
    if !crate::platform::valid_target(host) {
        return None;
    }
    let (prog, args) = crate::platform::ping_command(host, 1);
    let out = cmd(prog).args(&args).stdout(Stdio::piped()).stderr(Stdio::null()).output().ok()?;
    crate::platform::parse_ping(&String::from_utf8_lossy(&out.stdout)).first().copied()
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RouteMeasure {
    pub sent: u32,
    pub received: u32,
    pub rtts: Vec<Option<f64>>,
    pub min: Option<f64>,
    pub median: Option<f64>,
    pub p90: Option<f64>,
    /// Mean absolute difference of consecutive replies.
    pub jitter: Option<f64>,
    pub hops: Vec<crate::peak::PeakHop>,
}

pub fn measure_from(rtts: Vec<Option<f64>>) -> RouteMeasure {
    let got: Vec<f64> = rtts.iter().flatten().copied().collect();
    let mut sorted = got.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pick = |p: f64| (!sorted.is_empty()).then(|| crate::proof::quantile(&sorted, p));
    let jitter = (got.len() > 1).then(|| got.windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>() / (got.len() - 1) as f64);
    RouteMeasure { sent: rtts.len() as u32, received: got.len() as u32, min: sorted.first().copied(), median: pick(0.5), p90: pick(0.9), jitter, rtts, hops: Vec::new() }
}

pub fn ping_stats_from(host: &str, m: &RouteMeasure) -> PingStats {
    let got: Vec<f64> = m.rtts.iter().flatten().copied().collect();
    let avg = (!got.is_empty()).then(|| got.iter().sum::<f64>() / got.len() as f64);
    let mut sorted = got.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    PingStats {
        host: host.to_string(),
        sent: m.sent,
        received: m.received,
        min: m.min,
        avg,
        max: sorted.last().copied(),
        p95: (!sorted.is_empty()).then(|| crate::percentile(&sorted, 0.95)),
        jitter: avg.map(|a| (got.iter().map(|v| (v - a).powi(2)).sum::<f64>() / got.len() as f64).sqrt()),
    }
}

fn pings(host: &str, count: u32, mut each: impl FnMut(u32)) -> Vec<Option<f64>> {
    (0..count)
        .map(|i| {
            let r = ping_once(host);
            each(i + 1);
            r
        })
        .collect()
}

pub fn relay_ping_blocking(dir: &Path, count: u32) -> Result<PingStats, String> {
    let cfg = load(dir)?.ok_or("Import a relay config first.")?;
    let probe = probe_addr(&cfg).ok_or("The config's AllowedIPs has no relay tunnel address to ping.")?.to_string();
    if tunnel_state(dir) != TunnelState::Up {
        return Err("The relay is off. Turn it on to measure it.".into());
    }
    let m = measure_from(pings(&probe, count.clamp(1, 100), |_| {}));
    Ok(ping_stats_from(&probe, &m))
}

#[derive(Serialize, Clone, Debug)]
pub struct RelayComparison {
    pub target: String,
    pub relay_host: String,
    pub started_at: u64,
    pub finished_at: u64,
    pub direct: RouteMeasure,
    pub relay: Option<RouteMeasure>,
    pub error: Option<String>,
    /// The proof record the backend judged and saved for this run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<crate::proof::JudgedRecord>,
    /// Why the record could not be saved, when it could not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct CompareProgress {
    pub phase: &'static str,
    pub done: u32,
    pub total: u32,
}

/// Measures `target` direct and through the relay. Both can't run at once (with the tunnel up the
/// game ranges route through it), so this measures in the current state, switches the tunnel,
/// measures again, and puts the tunnel back as it was.
pub fn compare_blocking(dir: &Path, target: &str, count: u32, progress: impl Fn(CompareProgress)) -> Result<RelayComparison, String> {
    let cfg = load(dir)?.ok_or("Import a relay config first.")?;
    let ip: IpAddr = target.trim().parse().map_err(|_| format!("\"{target}\" is not an IP address"))?;
    if !routes_via_tunnel(&cfg, &ip) {
        return Err(format!("{ip} is not in the tunnel's ranges, so the tunnel would not carry it. With League picked the tunnel carries only game servers seen in matches; League's in-game ping is the proof there."));
    }
    if !installed(&find_tools()) {
        return Err(missing_message().into());
    }
    let total = count.clamp(1, 200);
    let host = ip.to_string();
    let run = |phase: &'static str| {
        let mut m = measure_from(pings(&host, total, |done| progress(CompareProgress { phase, done, total })));
        m.hops = crate::peak::trace_blocking(&host, 30).unwrap_or_default();
        m
    };
    let started_at = now_ms();
    guard_game(dir)?;
    let now = tunnel_state(dir);
    if now == TunnelState::Degraded {
        return Err("The tunnel is partly up. Press Off before comparing.".into());
    }
    let was_up = now == TunnelState::Up;
    let (mut direct, mut relay, mut errors) = (None, None, Vec::new());
    if was_up {
        relay = Some(run("relay"));
    } else {
        direct = Some(run("direct"));
    }
    match set_tunnel(dir, !was_up) {
        Ok(()) => {
            if was_up {
                direct = Some(run("direct"));
            } else {
                // The first packets wait on the handshake; let the relay answer before timing.
                if let Some(p) = probe_addr(&cfg) {
                    let _ = (0..5).find_map(|_| ping_once(&p.to_string()));
                }
                relay = Some(run("relay"));
            }
            if let Err(e) = set_tunnel(dir, was_up) {
                errors.push(format!("Could not put the tunnel back {}: {e}", if was_up { "up" } else { "down" }));
            }
        }
        Err(e) => errors.push(e),
    }
    let Some(direct) = direct else {
        return Err(errors.join(" "));
    };
    Ok(RelayComparison {
        target: host,
        relay_host: cfg.endpoint_host,
        started_at,
        finished_at: now_ms(),
        direct,
        relay,
        error: (!errors.is_empty()).then(|| errors.join(" ")),
        record: None,
        log_error: None,
    })
}

/// Saves the config under `name` and makes it the tunnel's relay. Relays imported earlier stay
/// saved for Auto.
pub fn import_blocking(dir: &Path, text: &str, name: Option<&str>) -> Result<RelaySummary, String> {
    let cfg = parse_config(text)?;
    if tunnel_state(dir) != TunnelState::Down {
        return Err("Turn the relay off before importing a new config.".into());
    }
    // An active config from before relays were saved keeps its place in the list.
    if let Some(old) = load(dir)? {
        if old.public_key != cfg.public_key && !read_saved(dir)?.iter().any(|r| r.cfg.public_key == old.public_key) {
            save(dir, &relay_id(None, &old), &old)?;
        }
    }
    let id = relay_id(name, &cfg);
    save(dir, &id, &cfg)?;
    store(dir, &crate::game_ranges::effective(dir, &cfg))?;
    Ok(summarize_named(&cfg, Some(&id)))
}

/// Removes the tunnel's relay and its saved copy. The first other saved relay, if any, takes over.
pub fn remove_blocking(dir: &Path) -> Result<(), String> {
    if tunnel_state(dir) != TunnelState::Down {
        return Err("Turn the relay off before removing its config.".into());
    }
    let gone = |r: std::io::Result<()>| match r {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    };
    let relays = list(dir)?;
    if let Some(id) = active_id(dir, &relays)? {
        gone(std::fs::remove_file(saved_file(dir, &id)))?;
        gone(std::fs::remove_file(crate::relay_api::meta_path(dir, &id)))?;
    }
    gone(std::fs::remove_file(conf_path(dir)))?;
    if let Some(next) = read_saved(dir)?.first() {
        store(dir, &crate::game_ranges::effective(dir, &next.cfg))?;
    }
    Ok(())
}

/// Headless control over the same code the app runs, for checking a real tunnel from a terminal:
/// `<app> --relay import FILE [NAME] | join INVITE [NAME] | refresh [NAME] | health [NAME] | leave [NAME]
/// | list | use NAME | up | down | status | ping | auto [TARGET...]`. INVITE is the `rigrelay1.` text
/// or a file holding it. NAME for refresh/health/leave defaults to the tunnel's relay.
/// Prints JSON, exits 0 on success. NAME defaults to the file name without `.conf`.
pub fn cli(args: &[String]) -> i32 {
    let dir = crate::peak::data_dir();
    let json = |v: serde_json::Result<serde_json::Value>| v.map_err(|e| e.to_string());
    let out = match args.first().map(String::as_str) {
        Some("import") => args
            .get(1)
            .ok_or_else(|| "usage: --relay import FILE [NAME]".to_string())
            .and_then(|f| {
                let name = args.get(2).cloned().or_else(|| Path::new(f).file_stem().map(|s| s.to_string_lossy().into_owned()));
                std::fs::read_to_string(f).map_err(|e| format!("{f}: {e}")).and_then(|t| import_blocking(&dir, &t, name.as_deref()))
            })
            .and_then(|s| json(serde_json::to_value(s))),
        Some("join") => args
            .get(1)
            .ok_or_else(|| "usage: --relay join INVITE|FILE [NAME]".to_string())
            .and_then(|a| {
                let text = if a.trim_start().starts_with(crate::relay_api::INVITE_PREFIX) { a.clone() } else { std::fs::read_to_string(a).map_err(|e| format!("{a}: {e}"))? };
                crate::relay_api::join_blocking(&dir, &text, args.get(2).map(String::as_str))
            })
            .and_then(|s| json(serde_json::to_value(s))),
        Some("refresh") => crate::relay_api::refresh_blocking(&dir, args.get(1).map(String::as_str), Duration::from_secs(10)).and_then(|r| json(serde_json::to_value(r))),
        Some("health") => crate::relay_api::health_blocking(&dir, args.get(1).map(String::as_str)),
        Some("leave") => crate::relay_api::leave_blocking(&dir, args.get(1).map(String::as_str)).map(|_| serde_json::json!({ "left": true })),
        Some("list") => list_summaries(&dir).and_then(|l| json(serde_json::to_value(l))),
        Some("use") => args
            .get(1)
            .ok_or_else(|| "usage: --relay use NAME".to_string())
            .and_then(|id| activate(&dir, id))
            .and_then(|_| json(serde_json::to_value(status(&dir)))),
        Some("guard") => json(Ok(serde_json::json!({ "game": game_running(&game_name(&dir)), "phase": client_phase(), "blocked": guard_game(&dir).err() }))),
        Some("matches") => crate::matches::ingest(&dir, now_ms(), game_running(DEFAULT_GAME).is_some()).and_then(|r| json(serde_json::to_value(r))),
        Some("auto") => crate::route_auto::auto_blocking(&dir, &args[1..], crate::route_auto::DEFAULT_ROUNDS, true, |_| {}).and_then(|mut r| {
            crate::route_auto::log_run(&dir, &mut r);
            json(serde_json::to_value(r))
        }),
        Some("up") => set_tunnel(&dir, true).and_then(|_| json(serde_json::to_value(status(&dir)))),
        Some("down") => set_tunnel(&dir, false).and_then(|_| json(serde_json::to_value(status(&dir)))),
        Some("status") => json(serde_json::to_value(status(&dir))),
        Some("ping") => relay_ping_blocking(&dir, 10).and_then(|p| json(serde_json::to_value(p))),
        _ => Err("usage: --relay import FILE [NAME] | join INVITE [NAME] | refresh [NAME] | health [NAME] | leave [NAME] | list | use NAME | up | down | status | ping | guard | matches | auto [TARGET...]".into()),
    };
    match out {
        Ok(v) => {
            println!("{v}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

// ---------- commands ----------

pub(crate) fn busy() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    BUSY.try_lock().map_err(|_| "Another relay change is still running.".to_string())
}

pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Checks and stores a config from the file the user picked. Returns what it says, without keys.
#[tauri::command]
pub async fn relay_import(app: AppHandle, text: String, name: Option<String>) -> Result<RelaySummary, String> {
    let dir = crate::app_dir(&app);
    blocking(move || {
        let _g = busy()?;
        import_blocking(&dir, &text, name.as_deref())
    })
    .await
}

/// Joins a relay with an invite from `rig-relay-invite`. This device makes its own key.
#[tauri::command]
pub async fn relay_join(app: AppHandle, invite: String, name: Option<String>) -> Result<RelaySummary, String> {
    let dir = crate::app_dir(&app);
    blocking(move || {
        let _g = busy()?;
        crate::relay_api::join_blocking(&dir, &invite, name.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn relay_refresh(app: AppHandle, name: Option<String>) -> Result<crate::relay_api::RefreshResult, String> {
    let dir = crate::app_dir(&app);
    blocking(move || {
        let _g = busy()?;
        crate::relay_api::refresh_blocking(&dir, name.as_deref(), Duration::from_secs(10))
    })
    .await
}

#[tauri::command]
pub async fn relay_health(app: AppHandle, name: Option<String>) -> Result<serde_json::Value, String> {
    let dir = crate::app_dir(&app);
    blocking(move || crate::relay_api::health_blocking(&dir, name.as_deref())).await
}

/// Removes this device from a joined relay and deletes the saved relay.
#[tauri::command]
pub async fn relay_leave(app: AppHandle, name: Option<String>) -> Result<(), String> {
    let dir = crate::app_dir(&app);
    blocking(move || {
        let _g = busy()?;
        crate::relay_api::leave_blocking(&dir, name.as_deref())
    })
    .await
}

#[tauri::command]
pub fn relay_config(app: AppHandle) -> Result<Option<RelaySummary>, String> {
    let dir = crate::app_dir(&app);
    let relays = list(&dir)?;
    let id = active_id(&dir, &relays)?;
    Ok(load(&dir)?.as_ref().map(|c| summarize_named(c, id.as_deref())))
}

#[tauri::command]
pub fn relay_list(app: AppHandle) -> Result<Vec<SavedSummary>, String> {
    list_summaries(&crate::app_dir(&app))
}

#[tauri::command]
pub fn relay_remove(app: AppHandle) -> Result<(), String> {
    let _g = busy()?;
    remove_blocking(&crate::app_dir(&app))
}

#[tauri::command]
pub async fn relay_status(app: AppHandle) -> Result<RelayStatus, String> {
    let dir = crate::app_dir(&app);
    blocking(move || Ok(status(&dir))).await
}

#[tauri::command]
pub async fn relay_up(app: AppHandle) -> Result<RelayStatus, String> {
    let dir = crate::app_dir(&app);
    blocking(move || {
        let _g = busy()?;
        // The user's own toggle: never refused in a game, only warned about.
        let warning = game_warning(&dir);
        if tunnel_state(&dir) == TunnelState::Down {
            crate::relay_api::refresh_before_connect(&dir, None);
        }
        set_tunnel_with(&dir, true, false)?;
        Ok(RelayStatus { warning, ..status(&dir) })
    })
    .await
}

/// The Relays panel's Connect: this saved relay, on.
#[tauri::command]
pub async fn relay_connect(app: AppHandle, name: String) -> Result<RelayStatus, String> {
    let dir = crate::app_dir(&app);
    blocking(move || {
        let _g = busy()?;
        let warning = game_warning(&dir);
        connect_blocking(&dir, &name, false)?;
        Ok(RelayStatus { warning, ..status(&dir) })
    })
    .await
}

#[tauri::command]
pub async fn relay_down(app: AppHandle) -> Result<RelayStatus, String> {
    let dir = crate::app_dir(&app);
    blocking(move || {
        let _g = busy()?;
        set_tunnel(&dir, false)?;
        Ok(status(&dir))
    })
    .await
}

#[tauri::command]
pub async fn relay_ping(app: AppHandle, count: Option<u32>) -> Result<PingStats, String> {
    let dir = crate::app_dir(&app);
    blocking(move || relay_ping_blocking(&dir, count.unwrap_or(10))).await
}

/// `relay` is accepted for the UI's convenience and ignored: the imported config names the relay.
#[tauri::command]
pub async fn relay_compare(app: AppHandle, target: String, relay: Option<String>, pings: Option<u32>) -> Result<RelayComparison, String> {
    let _ = relay;
    let dir = crate::app_dir(&app);
    blocking(move || {
        let _g = busy()?;
        let mut c = compare_blocking(&dir, &target, pings.unwrap_or(50), |p| {
            let _ = app.emit("compare:progress", p);
        })?;
        let (record, log_error) = crate::proof::save(&dir, crate::proof::from_comparison(&c));
        c.record = Some(record);
        c.log_error = log_error;
        Ok(c)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Placeholder keys (base64 of ASCII text) and documentation addresses, never real ones.
    const PRIV: &str = "cGxhY2Vob2xkZXIta2V5LW5vdC1yZWFsLTAwMDAwMDA=";
    const PUB: &str = "cGxhY2Vob2xkZXItcGVlci1ub3QtcmVhbC0xMTExMTE=";

    fn sample() -> String {
        format!(
            "# Rig Doctor relay client: toaster\n# Split tunnel\n[Interface]\nPrivateKey = {PRIV}\nAddress = 10.66.66.2/32\n\n[Peer]\nPublicKey = {PUB}\nEndpoint = 203.0.113.10:51820\nAllowedIPs = 10.66.66.1/32, 198.51.100.0/24, 192.0.2.0/25\nPersistentKeepalive = 25\n"
        )
    }

    #[test]
    fn parses_add_peer_output() {
        let c = parse_config(&sample()).unwrap();
        assert_eq!(c.endpoint_host, "203.0.113.10");
        assert_eq!(c.endpoint_port, 51820);
        assert_eq!(c.allowed_ips.len(), 3);
        assert_eq!(c.keepalive, Some(25));
        assert_eq!(probe_addr(&c).unwrap().to_string(), "10.66.66.1");
        let s = summarize(&c);
        assert_eq!(s.peer_key, "cGxhY2Vo");
        assert_eq!(s.endpoint, "203.0.113.10:51820");
    }

    #[test]
    fn render_round_trips_and_drops_comments() {
        let c = parse_config(&sample()).unwrap();
        let out = render_config(&c);
        assert!(!out.contains('#'));
        assert_eq!(parse_config(&out).unwrap(), c);
    }

    #[test]
    fn keys_and_sections_are_case_insensitive() {
        let t = sample().replace("[Interface]", "[interface]").replace("AllowedIPs", "allowedips");
        assert!(parse_config(&t).is_ok());
    }

    #[test]
    fn refuses_hooks_dns_and_full_tunnel() {
        let hook = sample().replace("Address = 10.66.66.2/32", "Address = 10.66.66.2/32\nPostUp = calc.exe");
        assert!(parse_config(&hook).unwrap_err().contains("runs commands"));
        let dns = sample().replace("Address = 10.66.66.2/32", "Address = 10.66.66.2/32\nDNS = 192.0.2.53");
        assert!(parse_config(&dns).unwrap_err().contains("DNS"));
        for wide in ["0.0.0.0/0", "0.0.0.0/1, 128.0.0.0/1", "::/0"] {
            let full = sample().replace("10.66.66.1/32, 198.51.100.0/24, 192.0.2.0/25", wide);
            assert!(parse_config(&full).unwrap_err().contains("all traffic"), "{wide}");
        }
    }

    #[test]
    fn refuses_bad_keys_and_shapes() {
        assert!(parse_config(&sample().replace(PUB, "not-a-key")).unwrap_err().contains("valid WireGuard key"));
        assert!(!valid_key("cGxhY2Vob2xkZXIta2V5LW5vdC1yZWFsLTAwMDAwMDB="), "last char has low bits set");
        assert!(parse_config(&sample().replace("Endpoint = 203.0.113.10:51820", "Endpoint = 203.0.113.10")).unwrap_err().contains("host:port"));
        assert!(parse_config(&sample().replace("Endpoint = 203.0.113.10:51820", "Endpoint = 203.0.113.10:0")).is_err());
        assert!(parse_config(&format!("{}\n[Peer]\n", sample())).unwrap_err().contains("exactly one"));
        assert!(parse_config(&sample().replace("PersistentKeepalive = 25", "PersistentKeepalive = 25\nPersistentKeepalive = 10")).unwrap_err().contains("twice"));
        assert!(parse_config(&sample().replace("PersistentKeepalive = 25", "Table = off")).unwrap_err().contains("not supported"));
        assert!(parse_config(&sample().replace("10.66.66.1/32", "10.66.66.1/33")).is_err());
        assert!(parse_config(&"x".repeat(MAX_CONF_BYTES + 1)).is_err());
        assert!(parse_config("PrivateKey = x\n").unwrap_err().contains("outside"));
    }

    #[test]
    fn ipv6_endpoint() {
        let c = parse_config(&sample().replace("203.0.113.10:51820", "[2001:db8::10]:51820")).unwrap();
        assert_eq!(c.endpoint_host, "2001:db8::10");
        assert!(render_config(&c).contains("Endpoint = [2001:db8::10]:51820"));
    }

    #[test]
    fn cidr_contains() {
        let c = parse_config(&sample()).unwrap();
        assert!(routes_via_tunnel(&c, &"198.51.100.77".parse().unwrap()));
        assert!(routes_via_tunnel(&c, &"192.0.2.127".parse().unwrap()));
        assert!(!routes_via_tunnel(&c, &"192.0.2.128".parse().unwrap()));
        assert!(!routes_via_tunnel(&c, &"2001:db8::1".parse().unwrap()));
    }

    #[test]
    fn stores_private_and_loads_back() {
        let dir = std::env::temp_dir().join(format!("rigrelay-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir).unwrap(), None);
        let c = parse_config(&sample()).unwrap();
        let p = store(&dir, &c).unwrap();
        assert_eq!(load(&dir).unwrap(), Some(c));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(p.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parses_wg_dump() {
        let dump = format!(
            "{PRIV}\t{PUB}\t51820\toff\n{PUB}\t(none)\t203.0.113.10:51820\t10.66.66.1/32,198.51.100.0/24\t1762484400\t1234\t5678\t25\n"
        );
        let p = parse_wg_dump(&dump).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].endpoint.as_deref(), Some("203.0.113.10:51820"));
        assert_eq!(p[0].allowed_ips, vec!["10.66.66.1/32", "198.51.100.0/24"]);
        assert_eq!(p[0].latest_handshake, Some(1762484400));
        assert_eq!((p[0].rx_bytes, p[0].tx_bytes, p[0].keepalive), (1234, 5678, Some(25)));
    }

    #[test]
    fn wg_dump_before_first_handshake() {
        let dump = format!("{PRIV}\t{PUB}\t0\toff\n{PUB}\t(none)\t(none)\t(none)\t0\t0\t0\toff\n");
        let p = parse_wg_dump(&dump).unwrap();
        assert_eq!(p[0].latest_handshake, None);
        assert_eq!(p[0].endpoint, None);
        assert!(p[0].allowed_ips.is_empty());
        assert_eq!(p[0].keepalive, None);
        assert!(parse_wg_dump(&format!("{PRIV}\n{PUB}\tbroken\n")).is_err());
        assert!(parse_wg_dump("").unwrap().is_empty());
    }

    #[test]
    fn parses_sc_query() {
        let running = "\r\nSERVICE_NAME: WireGuardTunnel$rigrelay\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 4  RUNNING\r\n";
        assert_eq!(parse_sc_state(running), Some(TunnelState::Up));
        assert_eq!(parse_sc_state(&running.replace("4  RUNNING", "2  START_PENDING")), Some(TunnelState::Starting));
        assert_eq!(parse_sc_state(&running.replace("4  RUNNING", "1  STOPPED")), Some(TunnelState::Down));
        assert_eq!(parse_sc_state("[SC] EnumQueryServicesStatus:OpenService FAILED 1060:"), None);
    }

    #[test]
    fn connect_refuses_an_unknown_relay_before_touching_the_tunnel() {
        let dir = std::env::temp_dir().join(format!("rigrelay-connect-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(connect_blocking(&dir, "nope", true), Err("No saved relay named nope.".into()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn spots_the_game_not_the_launcher() {
        for n in ["League of Legends.exe", "League of Legends", "League of Legend", "league of legends.exe"] {
            assert!(is_game_process(n, DEFAULT_GAME), "{n}");
        }
        for n in ["LeagueClient.exe", "LeagueClientUx", "Riot Client", "RiotClientServices.exe"] {
            assert!(!is_game_process(n, DEFAULT_GAME), "{n}");
        }
    }

    #[test]
    fn spots_a_picked_game() {
        let val = "VALORANT-Win64-Shipping";
        for n in ["VALORANT-Win64-Shipping.exe", "valorant-win64-shipping", "VALORANT-Win64-S"] {
            assert!(is_game_process(n, val), "{n}");
        }
        for n in ["VALORANT", "League of Legends.exe", "RiotClientServices.exe", ""] {
            assert!(!is_game_process(n, val), "{n}");
        }
        assert!(is_game_process("cs2.exe", "cs2"));
        assert!(!is_game_process("cs2helper.exe", "cs2"));
        assert!(!is_game_process("cs", "cs2"));
    }

    #[test]
    fn game_name_comes_from_the_app_config() {
        let dir = std::env::temp_dir().join(format!("rigrelay-game-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(game_name(&dir), DEFAULT_GAME);
        std::fs::write(dir.join("config.json"), r#"{"relays":[],"game":" cs2 "}"#).unwrap();
        assert_eq!(game_name(&dir), "cs2");
        std::fs::write(dir.join("config.json"), r#"{"relays":[],"game":""}"#).unwrap();
        assert_eq!(game_name(&dir), DEFAULT_GAME);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mac_state_never_reads_down_while_routes_remain() {
        assert_eq!(mac_state(Some("utun6"), Some("utun6"), true), TunnelState::Up);
        // Route to the relay deleted, game range still in the tunnel: the bug seen on the Mac.
        assert_eq!(mac_state(Some("en0"), Some("utun6"), true), TunnelState::Degraded);
        assert_eq!(mac_state(Some("en0"), Some("en0"), true), TunnelState::Degraded);
        assert_eq!(mac_state(Some("en0"), Some("en0"), false), TunnelState::Down);
        assert_eq!(mac_state(None, None, false), TunnelState::Down);
        let c = parse_config(&sample()).unwrap();
        assert_eq!(game_addr(&c).unwrap().to_string(), "198.51.100.0");
    }

    #[test]
    fn parses_macos_route_get() {
        let up = "   route to: 10.66.66.1\ndestination: 10.66.66.1\n  interface: utun6\n      flags: <UP,HOST,DONE,STATIC>\n";
        assert_eq!(parse_route_iface(up), Some("utun6"));
        let down = "   route to: 10.66.66.1\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: en0\n";
        assert_eq!(parse_route_iface(down), Some("en0"));
        assert_eq!(parse_route_iface("route: writing to routing socket: not in table"), None);
    }

    #[test]
    fn measure_stats() {
        let m = measure_from(vec![Some(30.0), None, Some(32.0), Some(28.0), Some(31.0)]);
        assert_eq!((m.sent, m.received), (5, 4));
        assert_eq!(m.min, Some(28.0));
        // Interpolated quantiles, the same as the proof record (proof::quantile).
        assert_eq!(m.median, Some(30.5));
        assert!((m.p90.unwrap() - 31.7).abs() < 1e-9);
        assert_eq!(m.jitter, Some((2.0 + 4.0 + 3.0) / 3.0));
        let lost = measure_from(vec![None, None]);
        assert_eq!((lost.min, lost.median, lost.jitter), (None, None, None));
        let s = ping_stats_from("10.66.66.1", &m);
        assert_eq!((s.avg, s.max, s.p95), (Some(30.25), Some(32.0), Some(32.0)));
    }

    #[test]
    fn elevation_scripts_quote_paths() {
        let ps = ps_elevate_script(r"C:\Program Files\WireGuard\wireguard.exe", r#"/installtunnelservice "C:\Users\o'neil\rigrelay.conf""#);
        assert!(ps.contains(r"-FilePath 'C:\Program Files\WireGuard\wireguard.exe'"));
        assert!(ps.contains(r#"-ArgumentList '/installtunnelservice "C:\Users\o''neil\rigrelay.conf"'"#));
        let conf = "/Users/o'neil/Library/Application Support/rigrelay.conf";
        let down = unix_line("/opt/homebrew/bin/wg-quick", "down", conf, true);
        assert_eq!(down, r"PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; '/opt/homebrew/bin/wg-quick' down '/Users/o'\''neil/Library/Application Support/rigrelay.conf' || rm -f /var/run/wireguard/rigrelay.sock /var/run/wireguard/rigrelay.name");
        let up = unix_line("/opt/homebrew/bin/wg-quick", "up", conf, true);
        assert!(up.contains("; } >/dev/null 2>&1; '/opt/homebrew/bin/wg-quick' up '/Users/o'\\''neil"), "{up}");
        assert!(unix_line("/usr/bin/wg-quick", "down", "/tmp/rigrelay.conf", false).ends_with("|| ip link del rigrelay"));
        assert_eq!(osascript_line(r#"a "b" \c"#), r#"do shell script "a \"b\" \\c" with administrator privileges"#);
    }

    #[test]
    fn finds_tools_in_dirs() {
        let dir = std::env::temp_dir().join(format!("rigrelay-tools-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("wg-quick"), "").unwrap();
        assert_eq!(find_in(&[PathBuf::from("/nonexistent"), dir.clone()], "wg-quick"), Some(dir.join("wg-quick")));
        // PATH in this OS's own form: ':' between entries on Unix, ';' on Windows.
        let path = std::env::join_paths(["/home/u/bin", "/usr/bin"]).unwrap();
        let dirs = unix_tool_dirs(Some(&path));
        assert_eq!(&dirs[..3], &[PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin"), PathBuf::from("/home/u/bin")]);
        assert_eq!(find_in(std::slice::from_ref(&dir), "wg"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    const PUB2: &str = "cGxhY2Vob2xkZXItcGVlci1ub3QtcmVhbC0yMjIyMjI=";

    #[test]
    fn lockfile_gives_port_and_password() {
        assert_eq!(parse_lockfile("LeagueClient:1234:50123:placeholder-pass:https\n"), Some((50123, "placeholder-pass".into())));
        assert_eq!(parse_lockfile("LeagueClient:1234:notaport:pw:https"), None);
        assert_eq!(parse_lockfile("LeagueClient:1234:50123::https"), None);
        assert_eq!(parse_lockfile(""), None);
    }

    #[test]
    fn guard_blocks_from_ready_check_to_game_end() {
        for p in ["ReadyCheck", "ChampSelect", "GameStart", "InProgress", "Reconnect"] {
            assert!(phase_blocks(p).is_some(), "{p}");
        }
        for p in ["None", "Lobby", "Matchmaking", "WaitingForStats", "PreEndOfGame", "EndOfGame", ""] {
            assert!(phase_blocks(p).is_none(), "{p}");
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rig-relay-{tag}-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn relay_names_are_slugs_or_from_the_key() {
        let c = parse_config(&sample()).unwrap();
        assert_eq!(relay_id(Some("Relay EWR 1"), &c), "relay-ewr-1");
        assert_eq!(relay_id(Some("wg_toaster.chi"), &c), "wg-toaster-chi");
        assert_eq!(relay_id(Some("  "), &c), "relay-cgxhy2vo");
        assert_eq!(relay_id(Some("Direct"), &c), "relay-cgxhy2vo", "never the direct path's id");
        assert_eq!(relay_id(Some(&"x".repeat(40)), &c).len(), 32);
    }

    #[test]
    fn import_keeps_every_relay_and_activates_the_new_one() {
        let dir = temp_dir("import");
        let second = sample().replace(PUB, PUB2).replace("203.0.113.10", "203.0.113.20");
        // A config from before relays were saved is listed under a name from its key.
        store(&dir, &parse_config(&sample()).unwrap()).unwrap();
        let l = list(&dir).unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(active_id(&dir, &l).unwrap().as_deref(), Some("relay-cgxhy2vo"));

        let s = import_blocking(&dir, &second, Some("relay-ewr-1")).unwrap();
        assert_eq!(s.name.as_deref(), Some("relay-ewr-1"));
        let l = list(&dir).unwrap();
        assert_eq!(l.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["relay-cgxhy2vo", "relay-ewr-1"], "old one saved, new one added");
        assert_eq!(active_id(&dir, &l).unwrap().as_deref(), Some("relay-ewr-1"));

        // Re-importing the same relay under a new name renames it rather than duplicating it.
        import_blocking(&dir, &sample(), Some("relay-chi-1")).unwrap();
        let l = list(&dir).unwrap();
        assert_eq!(l.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["relay-chi-1", "relay-ewr-1"]);

        activate(&dir, "relay-ewr-1").unwrap();
        assert_eq!(load(&dir).unwrap().unwrap().endpoint_host, "203.0.113.20");
        assert!(activate(&dir, "nope").is_err());

        // Removing the tunnel's relay hands the tunnel to the next one saved.
        remove_blocking(&dir).unwrap();
        let l = list(&dir).unwrap();
        assert_eq!(l.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["relay-chi-1"]);
        assert_eq!(active_id(&dir, &l).unwrap().as_deref(), Some("relay-chi-1"));
        remove_blocking(&dir).unwrap();
        assert!(list(&dir).unwrap().is_empty());
        assert!(load(&dir).unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
