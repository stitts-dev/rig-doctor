//! Relay billing (relay/api.py, /v1/billing): this device's trial or subscription on a billed relay,
//! Subscribe, Cancel and Manage billing, and the monthly refund verdicts. The relay bills by
//! calendar month. Once a month is over here, the app sends that month's verdict from the proof
//! log (proof.rs, the rule the app shows), so the relay can refund a month with no measured gain.
//!
//! Checkout and the billing portal open in the system browser on Stripe's own pages: card details
//! never pass through the app or the relay API.

use crate::proof::{self, MonthVerdict};
use crate::relay;
use crate::relay_api::{self, ApiMeta, Method, CALL_TIMEOUT};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Verdicts one call may carry (the API takes 1 to 6).
pub const MAX_VERDICTS: usize = 6;
/// Longest verdict text the API takes, in characters.
pub const MAX_TEXT: usize = 240;
/// The verdict for a billed month this PC has no runs or matches for: nothing shows a gain.
pub const NO_DATA_TEXT: &str = "No comparisons or League matches this month on this PC. No gain shown, refund due.";
const BAD_LINK: &str = "The relay sent a billing link that is not a plain https link, so it was not opened.";

/// One month's verdict, as POST /v1/billing/verdicts takes it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MonthReport {
    /// Local calendar month, "YYYY-MM".
    pub month: String,
    pub gained: bool,
    pub text: String,
}

/// "YYYY-MM" with a month from 01 to 12.
fn valid_month(m: &str) -> bool {
    let b = m.as_bytes();
    b.len() == 7 && b[4] == b'-' && b[..4].iter().chain(&b[5..]).all(u8::is_ascii_digit) && (1..=12).contains(&((b[5] - b'0') * 10 + (b[6] - b'0')))
}

/// The first `max` characters of `s`, cut on a character boundary.
fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

/// The verdicts to send for the months the relay waits on, at most MAX_VERDICTS, in the relay's
/// order. A month goes only once it is over here: `current` is this PC's local month
/// (proof::month_key of now), so a month that already ended in UTC waits for local midnight on the
/// 1st. A month the logs have nothing for shows no gain, so its refund is due.
pub fn verdicts_for(needed: &[String], months: &[MonthVerdict], current: &str) -> Vec<MonthReport> {
    let mut out: Vec<MonthReport> = Vec::new();
    for m in needed.iter().filter(|m| valid_month(m) && m.as_str() < current) {
        if out.len() == MAX_VERDICTS {
            break;
        }
        if out.iter().any(|r| &r.month == m) {
            continue;
        }
        out.push(match months.iter().find(|v| &v.month == m) {
            Some(v) => MonthReport { month: m.clone(), gained: v.gained, text: clip(&v.text, MAX_TEXT) },
            None => MonthReport { month: m.clone(), gained: false, text: NO_DATA_TEXT.to_string() },
        });
    }
    out
}

/// A Checkout or portal link from the relay, checked before the system browser gets it: https to a
/// named host, with no user name or password in it. Returns the link as the browser will get it.
pub fn safe_link(raw: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| BAD_LINK.to_string())?;
    if url.scheme() != "https" || url.host().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(BAD_LINK.into());
    }
    Ok(url.into())
}

/// Months the relay waits on a verdict for, as it lists them.
fn needed(status: &serde_json::Value) -> Vec<String> {
    status.get("verdicts_needed").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|m| m.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// The status object with the saved relay it is about, so the UI acts on that relay.
fn with_relay(mut status: serde_json::Value, id: &str) -> Result<serde_json::Value, String> {
    let o = status.as_object_mut().ok_or("Relay API billing answer is not an object.")?;
    o.insert("relay".into(), serde_json::Value::String(id.to_string()));
    Ok(status)
}

/// The saved relay (`name`, else the tunnel's) and its API settings. None when there is nothing to
/// bill: no relay is picked yet, or it was imported from a file and has no relay API.
fn joined(dir: &Path, name: Option<&str>) -> Result<Option<(String, ApiMeta)>, String> {
    if name.is_none() && relay::active_id(dir, &relay::list(dir)?)?.is_none() {
        return Ok(None);
    }
    let r = relay_api::resolve(dir, name)?;
    Ok(relay_api::load_meta(dir, &r.id)?.map(|m| (r.id, m)))
}

/// Like `joined`, for the actions: a relay without an API can't take them.
fn require_joined(dir: &Path, name: Option<&str>) -> Result<(String, ApiMeta), String> {
    let r = relay_api::resolve(dir, name)?;
    let meta = relay_api::load_meta(dir, &r.id)?.ok_or_else(|| format!("{} has no relay API (imported from a file), so it has no billing.", r.id))?;
    Ok((r.id, meta))
}

fn post(meta: &ApiMeta, path: &str, body: serde_json::Value) -> Result<(u16, serde_json::Value), String> {
    relay_api::call(&meta.api, &meta.cert, Some(&meta.token), Method::Post(body), path, CALL_TIMEOUT)
}

/// The relay's billing state for this device, after sending the verdicts it waits on. None when
/// the relay has no API (imported from a file), no relay is picked, or the relay predates billing
/// (404). A verdict that can't be sent never hides the state: the relay asks again next time.
pub fn status_blocking(dir: &Path, name: Option<&str>, now_ms: u64, tz_offset_min: i32) -> Result<Option<serde_json::Value>, String> {
    let Some((id, meta)) = joined(dir, name)? else { return Ok(None) };
    let (code, mut status) = relay_api::call(&meta.api, &meta.cert, Some(&meta.token), Method::Get, "/v1/billing", CALL_TIMEOUT)?;
    if code == 404 {
        return Ok(None);
    }
    if code != 200 {
        return Err(relay_api::api_error(code, &status));
    }
    let months = needed(&status);
    if !months.is_empty() {
        match report(dir, &meta, &months, now_ms, tz_offset_min) {
            Ok(Some(after)) => status = after,
            Ok(None) => {}
            Err(e) => eprintln!("billing {id}: verdicts not sent: {e}"),
        }
    }
    with_relay(status, &id).map(Some)
}

/// Sends the verdicts for the months the relay waits on and returns its status after them, or None
/// when none of those months is over here yet. A proof log that can't be read sends nothing: a
/// verdict made without the log could be wrong either way.
fn report(dir: &Path, meta: &ApiMeta, needed: &[String], now_ms: u64, tz_offset_min: i32) -> Result<Option<serde_json::Value>, String> {
    let months = proof::history(dir, now_ms, tz_offset_min)?.months;
    let verdicts = verdicts_for(needed, &months, &proof::month_key(now_ms, tz_offset_min));
    if verdicts.is_empty() {
        return Ok(None);
    }
    let (code, body) = post(meta, "/v1/billing/verdicts", serde_json::json!({ "verdicts": verdicts }))?;
    if code != 200 {
        return Err(relay_api::api_error(code, &body));
    }
    if !body.is_object() {
        return Err("Relay API billing answer is not an object.".into());
    }
    Ok(Some(body))
}

#[derive(Deserialize)]
struct Link {
    url: String,
}

/// Asks the relay for a Stripe link (POST `path`) and checks it.
fn link_blocking(dir: &Path, name: Option<&str>, path: &str) -> Result<String, String> {
    let (_, meta) = require_joined(dir, name)?;
    let link: Link = relay_api::ok_json(post(&meta, path, serde_json::json!({}))?)?;
    safe_link(&link.url)
}

/// Cancels at the end of the paid period. Returns the status after it.
pub fn cancel_blocking(dir: &Path, name: Option<&str>) -> Result<serde_json::Value, String> {
    let (id, meta) = require_joined(dir, name)?;
    let (code, body) = post(&meta, "/v1/billing/cancel", serde_json::json!({}))?;
    if code != 200 {
        return Err(relay_api::api_error(code, &body));
    }
    with_relay(body, &id)
}

/// `tz_offset_min` is JavaScript's getTimezoneOffset(), for this PC's calendar months.
#[tauri::command]
pub async fn billing_status(app: AppHandle, name: Option<String>, tz_offset_min: Option<i32>) -> Result<Option<serde_json::Value>, String> {
    let dir = crate::app_dir(&app);
    relay::blocking(move || status_blocking(&dir, name.as_deref(), relay::now_ms(), tz_offset_min.unwrap_or(0))).await
}

async fn open_link(app: AppHandle, name: Option<String>, path: &'static str) -> Result<(), String> {
    let dir = crate::app_dir(&app);
    relay::blocking(move || {
        let url = link_blocking(&dir, name.as_deref(), path)?;
        app.opener().open_url(url, None::<&str>).map_err(|e| format!("Could not open the browser: {e}"))
    })
    .await
}

/// Opens Stripe Checkout for the relay's plan in the system browser.
#[tauri::command]
pub async fn billing_checkout(app: AppHandle, name: Option<String>) -> Result<(), String> {
    open_link(app, name, "/v1/billing/checkout").await
}

/// Opens Stripe's billing portal (card, invoices) in the system browser.
#[tauri::command]
pub async fn billing_portal(app: AppHandle, name: Option<String>) -> Result<(), String> {
    open_link(app, name, "/v1/billing/portal").await
}

#[tauri::command]
pub async fn billing_cancel(app: AppHandle, name: Option<String>) -> Result<serde_json::Value, String> {
    let dir = crate::app_dir(&app);
    relay::blocking(move || cancel_blocking(&dir, name.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn verdict(month: &str, gained: bool, text: &str) -> MonthVerdict {
        MonthVerdict { month: month.into(), runs: 3, judged: 3, gains: if gained { 3 } else { 0 }, median_saved_ms: Some(if gained { 48.0 } else { 2.0 }), gained, text: text.into(), in_game: None }
    }

    fn months(m: &[&str]) -> Vec<String> {
        m.iter().map(|s| s.to_string()).collect()
    }

    const GAIN: &str = "Gain shown: median 48 ms saved over 9 runs (8 gained). No refund due.";
    const NONE: &str = "No gain shown: median 2 ms saved over 4 runs, under the 10 ms bar. Refund due.";

    #[test]
    fn sends_a_month_only_once_it_is_over_here() {
        let log = [verdict("2026-11", true, GAIN), verdict("2026-10", false, NONE)];
        // November is this month: its verdict can still change, so only October goes.
        let v = verdicts_for(&months(&["2026-10", "2026-11", "2026-12"]), &log, "2026-11");
        assert_eq!(v, [MonthReport { month: "2026-10".into(), gained: false, text: NONE.into() }]);
        // From midnight on December 1st here, November is over too, with its own verdict.
        let v = verdicts_for(&months(&["2026-10", "2026-11"]), &log, "2026-12");
        assert_eq!(v.iter().map(|r| (r.month.as_str(), r.gained, r.text.as_str())).collect::<Vec<_>>(), [("2026-10", false, NONE), ("2026-11", true, GAIN)]);
        // 2026-11-01 03:00 UTC: October is over in UTC but not yet in New York (offset +240).
        let ts = 1_793_502_000_000;
        assert!(verdicts_for(&months(&["2026-10"]), &log, &proof::month_key(ts, 240)).is_empty());
        assert_eq!(verdicts_for(&months(&["2026-10"]), &log, &proof::month_key(ts, 0)).len(), 1);
    }

    #[test]
    fn a_month_without_runs_or_matches_is_a_refund() {
        let v = verdicts_for(&months(&["2026-09"]), &[verdict("2026-10", true, GAIN)], "2026-11");
        assert_eq!(v, [MonthReport { month: "2026-09".into(), gained: false, text: NO_DATA_TEXT.into() }]);
        assert!(NO_DATA_TEXT.chars().count() <= MAX_TEXT);
    }

    #[test]
    fn skips_malformed_months_and_repeats() {
        let bad = ["2026-13", "2026-00", "26-10", "2026-1", "2026/10", "2026-10 ", "", "abcd-ef", "２０２６-10", "2026-1x"];
        assert!(verdicts_for(&months(&bad), &[], "2026-11").is_empty());
        assert_eq!(verdicts_for(&months(&["2026-10", "2026-10", "2026-12x"]), &[], "2026-11").len(), 1);
    }

    #[test]
    fn sends_at_most_six() {
        let needed: Vec<String> = (1..=9).map(|m| format!("2026-{m:02}")).collect();
        let v = verdicts_for(&needed, &[], "2026-11");
        assert_eq!(v.len(), MAX_VERDICTS);
        assert_eq!(v.iter().map(|r| r.month.as_str()).collect::<Vec<_>>(), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
        // Months not over yet don't use up the six.
        let mut later = months(&["2026-11", "2026-12"]);
        later.extend(needed);
        assert_eq!(verdicts_for(&later, &[], "2026-11").len(), MAX_VERDICTS);
    }

    #[test]
    fn long_text_is_cut_on_a_character_boundary() {
        // Two bytes per "é": a byte cut at 240 would land inside one.
        let long = format!("x{}", "é".repeat(400));
        let v = verdicts_for(&months(&["2026-10"]), &[verdict("2026-10", false, &long)], "2026-11");
        assert_eq!(v[0].text.chars().count(), MAX_TEXT);
        assert!(long.starts_with(&v[0].text));
        let exact = "y".repeat(MAX_TEXT);
        assert_eq!(verdicts_for(&months(&["2026-10"]), &[verdict("2026-10", true, &exact)], "2026-11")[0].text, exact);
    }

    #[test]
    fn verdicts_serialize_as_the_api_takes_them() {
        let v = verdicts_for(&months(&["2026-10"]), &[verdict("2026-10", false, NONE)], "2026-11");
        assert_eq!(serde_json::json!({ "verdicts": v }), serde_json::json!({"verdicts": [{"month": "2026-10", "gained": false, "text": NONE}]}));
    }

    #[test]
    fn opens_only_plain_https_links() {
        assert_eq!(safe_link("https://checkout.stripe.com/c/pay/cs_test_a1b2#fid=x").unwrap(), "https://checkout.stripe.com/c/pay/cs_test_a1b2#fid=x");
        assert_eq!(safe_link("https://billing.stripe.com/p/session/test_YWNjdA").unwrap(), "https://billing.stripe.com/p/session/test_YWNjdA");
        for bad in [
            "http://checkout.stripe.com/c/pay/cs_test",
            "https://user@checkout.stripe.com/c/pay",
            "https://user:pw@checkout.stripe.com/c/pay",
            "https://:pw@billing.stripe.com/p",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "ms-settings:privacy",
            "checkout.stripe.com/c/pay",
            "https://",
            "",
        ] {
            assert!(safe_link(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn reads_the_months_and_names_the_relay() {
        let s = serde_json::json!({"enabled": true, "state": "active", "verdicts_needed": ["2026-10", 7, "2026-09"]});
        assert_eq!(needed(&s), ["2026-10", "2026-09"]);
        assert!(needed(&serde_json::json!({"enabled": false})).is_empty());
        assert_eq!(with_relay(s, "relay-chi-1").unwrap()["relay"], "relay-chi-1");
        assert!(with_relay(serde_json::json!([]), "relay-chi-1").is_err());
    }

    const RELAY: &str = "cGxhY2Vob2xkZXJwbGFjZWhvbGRlcnBsYWNlaG9sZGU=";
    const DEVICE: &str = "ZGV2aWNla2V5ZGV2aWNla2V5ZGV2aWNla2V5ZGV2aWM=";

    fn tmp() -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("rd-billing-{}-{}-{n}", std::process::id(), relay::now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn no_billing_without_a_joined_relay() {
        let d = tmp();
        // Nothing picked yet: the section stays hidden, and no error shows.
        assert_eq!(status_blocking(&d, None, relay::now_ms(), 0).unwrap(), None);
        // A relay imported from a file has no API, so nothing to bill, picked or named.
        let cfg = relay::parse_config(&format!("[Interface]\nPrivateKey = {DEVICE}\nAddress = 10.66.66.2/32\n\n[Peer]\nPublicKey = {RELAY}\nEndpoint = 198.51.100.1:51820\nAllowedIPs = 10.66.66.1/32, 198.51.100.0/24\n")).unwrap();
        relay::save_relay(&d, "filed", &cfg).unwrap();
        relay::store(&d, &cfg).unwrap();
        assert_eq!(status_blocking(&d, None, relay::now_ms(), 0).unwrap(), None);
        assert_eq!(status_blocking(&d, Some("filed"), relay::now_ms(), 0).unwrap(), None);
        assert!(cancel_blocking(&d, Some("filed")).unwrap_err().contains("no relay API"));
        assert!(link_blocking(&d, None, "/v1/billing/checkout").unwrap_err().contains("no relay API"));
        assert!(status_blocking(&d, Some("missing"), relay::now_ms(), 0).unwrap_err().contains("No saved relay"));
        std::fs::remove_dir_all(d).unwrap();
    }
}
