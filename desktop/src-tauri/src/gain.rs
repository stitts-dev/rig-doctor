//! The relay's gain table: which ISP networks (AS numbers) and regions a relay actually helps.
//!
//! Once this device has MIN_MATCHES League matches on both paths, it sends its in-game gain to the
//! relay it plays through (`POST /v1/gain`), filed under its ISP's AS number and region from the
//! offline DB-IP database. The relay answers with what players on the same network measured, and
//! the relay card shows that next to the month verdict. Only the AS number, the region and the ping
//! numbers leave this machine: no address, no match or player id. The relay files each report
//! under an HMAC of the player name and keeps one per player (relay/api.py).

use crate::geoip::OfflineDb;
use crate::matches::{MatchPing, MIXED};
use crate::proof::quantile;
use crate::relay_api::{self, ApiMeta, Method};
use crate::route_auto::{AUTO_MIN_GAIN_MS, MIN_MATCHES, RECENT_MATCHES};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

pub const GAME: &str = "league";
/// Players a row needs before the card quotes its number. With fewer it shows the count.
pub const MIN_PLAYERS: usize = 3;
pub const TABLE_FILE: &str = "gain-table.json";
/// A fetched table answers for an hour. A new match or another relay asks again sooner.
const TABLE_TTL_MS: u64 = 3_600_000;
const CALL_TIMEOUT: Duration = Duration::from_secs(5);

/// This machine's ISP network, as the table files it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Network {
    pub asn: u32,
    /// The network owner's name from the database, for the card.
    pub isp: Option<String>,
    /// "Pennsylvania, United States": never finer than a state or province.
    pub region: Option<String>,
}

/// One upload: this device's numbers on one relay.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Report {
    pub v: u32,
    pub game: String,
    pub source: String,
    pub asn: u32,
    pub region: Option<String>,
    pub direct_ms: f64,
    pub relay_ms: f64,
    pub direct_loss: Option<f64>,
    pub relay_loss: Option<f64>,
    pub direct_n: usize,
    pub relay_n: usize,
}

/// A table row as the relay sends it. `region` None covers the whole network.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Row {
    /// "in_game" or "estimate" (the gain check script).
    pub source: String,
    pub asn: u32,
    pub region: Option<String>,
    pub players: usize,
    pub median_gain_ms: f64,
    /// Players who gain the bar (10 ms) or more.
    pub gaining: usize,
    pub median_direct_ms: f64,
    pub median_relay_ms: f64,
}

/// The rows for this machine's network, as last fetched from a relay.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Table {
    pub relay: String,
    pub network: Network,
    pub rows: Vec<Row>,
    pub fetched_ms: u64,
    /// This device's own report went with the fetch.
    pub sent: bool,
}

/// What the relay card shows.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GainView {
    pub relay: String,
    pub asn: u32,
    /// "gain", "none" or "worse" when a row has MIN_PLAYERS players, else "few".
    pub kind: String,
    /// The row the sentence quotes: "in_game", "estimate", or None while too few players measured.
    pub source: Option<String>,
    pub text: String,
    pub players: usize,
    pub median_gain_ms: Option<f64>,
    pub fetched_ms: u64,
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    quantile(&v, 0.5)
}

/// The relay's rule for a region: 1-64 printable characters, none of < > " \, no outer spaces.
pub fn valid_region(s: &str) -> bool {
    let n = s.chars().count();
    (1..=64).contains(&n) && s.trim() == s && !s.chars().any(|c| c.is_control() || (c.is_whitespace() && c != ' ') || "<>\"\\".contains(c))
}

/// The AS number and coarse region of a GeoIP answer. None without an AS number.
pub fn network_of(g: &crate::Geo) -> Option<Network> {
    let asn = g.asn.as_deref()?.strip_prefix("AS")?.split_whitespace().next()?.parse::<u32>().ok().filter(|n| *n > 0)?;
    let clean = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let region = match (clean(&g.region), clean(&g.country)) {
        (Some(r), Some(c)) => Some(format!("{r}, {c}")),
        (None, Some(c)) => Some(c),
        _ => None,
    }
    .filter(|r| valid_region(r));
    Some(Network { asn, isp: clean(&g.isp), region })
}

/// This machine's network: its public address looked up in the offline database.
pub fn own_network(db: Option<&OfflineDb>) -> Option<Network> {
    let db = db?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().ok()?;
    let ip = tauri::async_runtime::block_on(crate::geoip::public_ip(&client))?;
    network_of(&db.lookup("self", ip)?)
}

/// This device's in-game gain on relay `relay_id`: the newest RECENT_MATCHES matches on each path,
/// as Auto reads them, once both paths have MIN_MATCHES. Matches whose path changed mid-match are
/// tagged mixed and count on neither path.
pub fn in_game(log: &[MatchPing], relay_id: &str, net: &Network) -> Option<Report> {
    if ["direct", "unknown", MIXED].contains(&relay_id) {
        return None;
    }
    let on = |path: &str| {
        let mut ms: Vec<&MatchPing> = log.iter().filter(|m| m.path == path).collect();
        ms.sort_by(|a, b| b.id.cmp(&a.id));
        ms.truncate(RECENT_MATCHES);
        ms
    };
    let (d, r) = (on("direct"), on(relay_id));
    if d.len() < MIN_MATCHES || r.len() < MIN_MATCHES {
        return None;
    }
    let ping = |ms: &[&MatchPing]| round1(median(ms.iter().map(|m| m.median_ms).collect()));
    let loss = |ms: &[&MatchPing]| (median(ms.iter().map(|m| m.loss).collect()) * 10_000.0).round() / 10_000.0;
    let (direct_ms, relay_ms) = (ping(&d), ping(&r));
    // The relay takes 0.1-1000 ms. A match outside that is a broken log, not a ping.
    if ![direct_ms, relay_ms].iter().all(|v| (0.1..=1000.0).contains(v)) {
        return None;
    }
    Some(Report {
        v: 1,
        game: GAME.into(),
        source: "in_game".into(),
        asn: net.asn,
        region: net.region.clone(),
        direct_ms,
        relay_ms,
        direct_loss: Some(loss(&d)),
        relay_loss: Some(loss(&r)),
        direct_n: d.len(),
        relay_n: r.len(),
    })
}

/// "Comcast Cable Communications (AS7922)", or "AS7922" without a name.
fn network_label(n: &Network) -> String {
    match n.isp.as_deref().and_then(|s| s.split(',').next()).map(str::trim).filter(|s| !s.is_empty()) {
        Some(isp) => format!("{isp} (AS{})", n.asn),
        None => format!("AS{}", n.asn),
    }
}

fn gains(g: f64) -> String {
    if g >= 0.5 {
        format!("gain {g:.0} ms")
    } else if g <= -0.5 {
        format!("lose {:.0} ms", -g)
    } else {
        "gain nothing".into()
    }
}

fn players(n: usize) -> String {
    if n == 1 { "1 player".into() } else { format!("{n} players") }
}

/// The card's sentence. In-game numbers come first: this machine's region when it has
/// MIN_PLAYERS players, else the whole network, then gain check estimates, else the count so far.
pub fn view(t: &Table) -> GainView {
    let n = &t.network;
    let who = network_label(n);
    let find = |source: &str, region: Option<&str>| t.rows.iter().find(|r| r.source == source && r.asn == n.asn && r.region.as_deref() == region);
    let enough = |r: Option<&Row>| r.filter(|r| r.players >= MIN_PLAYERS).cloned();
    let local = n.region.as_deref().and_then(|reg| enough(find("in_game", Some(reg))).map(|r| (r, reg)));
    let base = GainView { relay: t.relay.clone(), asn: n.asn, kind: "few".into(), source: None, text: String::new(), players: 0, median_gain_ms: None, fetched_ms: t.fetched_ms };
    let kind = |g: f64| {
        if g >= AUTO_MIN_GAIN_MS {
            "gain"
        } else if g <= -AUTO_MIN_GAIN_MS {
            "worse"
        } else {
            "none"
        }
    };
    let quoted = |r: &Row, text: String| GainView { kind: kind(r.median_gain_ms).into(), source: Some(r.source.clone()), text, players: r.players, median_gain_ms: Some(r.median_gain_ms), ..base.clone() };
    let by = |r: &Row| format!("{}, {} by {AUTO_MIN_GAIN_MS:.0} ms or more", players(r.players), r.gaining);
    if let Some((r, reg)) = local {
        let place = reg.split(',').next().unwrap_or(reg).trim();
        return quoted(&r, format!("Players on {who} in {place} {} in game with {}: {}.", gains(r.median_gain_ms), t.relay, by(&r)));
    }
    if let Some(r) = enough(find("in_game", None)) {
        return quoted(&r, format!("Players on {who} {} in game with {}: {}.", gains(r.median_gain_ms), t.relay, by(&r)));
    }
    if let Some(r) = enough(find("estimate", None)) {
        return quoted(&r, format!("Gain checks by {} on {who} estimate they {} with {}. Not yet measured in game.", players(r.players), gains(r.median_gain_ms), t.relay));
    }
    let measured = find("in_game", None).map_or(0, |r| r.players);
    GainView { players: measured, text: format!("Players on {who}: {} measured in game by {measured} of the {MIN_PLAYERS} players needed.", t.relay), ..base }
}

// ---------- storage ----------

pub fn load(dir: &Path) -> Option<Table> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(TABLE_FILE)).ok()?).ok()
}

fn store(dir: &Path, t: &Table) {
    let r = serde_json::to_string(t).map_err(|e| e.to_string()).and_then(|s| std::fs::write(dir.join(TABLE_FILE), s).map_err(|e| e.to_string()));
    if let Err(e) = r {
        eprintln!("gain table: {e}");
    }
}

// ---------- relay calls ----------

/// The tunnel's relay, when it was joined with an invite (only those have an API).
fn active_joined(dir: &Path) -> Result<Option<(String, ApiMeta)>, String> {
    let relays = crate::relay::list(dir)?;
    let Some(id) = crate::relay::active_id(dir, &relays)? else { return Ok(None) };
    Ok(relay_api::load_meta(dir, &id)?.map(|m| (id, m)))
}

fn rows_of(status: u16, body: &serde_json::Value) -> Result<Vec<Row>, String> {
    match status {
        200 => serde_json::from_value(body.get("rows").cloned().unwrap_or_default()).map_err(|_| "Relay API answer is missing fields.".to_string()),
        404 => Err("This relay has no gain table yet: its API needs an update.".into()),
        _ => Err(relay_api::api_error(status, body)),
    }
}

/// Sends this device's report to the tunnel's relay when it has one, and keeps the rows for its
/// network from the answer (or asks for them when there is nothing to send). None when the
/// tunnel's relay was not joined with an invite.
pub fn sync_blocking(dir: &Path, db: Option<&OfflineDb>) -> Result<Option<Table>, String> {
    let Some((id, meta)) = active_joined(dir)? else { return Ok(None) };
    let net = own_network(db).ok_or("This network could not be identified: no GeoIP answer for its address.")?;
    let report = in_game(&crate::matches::read_log(dir), &id, &net);
    let (status, body) = match &report {
        Some(rep) => relay_api::call(&meta.api, &meta.cert, Some(&meta.token), Method::Post(serde_json::to_value(rep).map_err(|e| e.to_string())?), "/v1/gain", CALL_TIMEOUT)?,
        None => relay_api::call(&meta.api, &meta.cert, Some(&meta.token), Method::Get, &format!("/v1/gain?game={GAME}&asn={}", net.asn), CALL_TIMEOUT)?,
    };
    let t = Table { relay: id, network: net, rows: rows_of(status, &body)?, fetched_ms: crate::relay::now_ms(), sent: report.is_some() };
    store(dir, &t);
    Ok(Some(t))
}

/// The whole table of relay `name` (default: the tunnel's), for the CLI.
pub fn table_blocking(dir: &Path, name: Option<&str>) -> Result<serde_json::Value, String> {
    let r = relay_api::resolve(dir, name)?;
    let meta = relay_api::load_meta(dir, &r.id)?.ok_or_else(|| format!("{} has no relay API (imported from a file).", r.id))?;
    let (status, body) = relay_api::call(&meta.api, &meta.cert, Some(&meta.token), Method::Get, &format!("/v1/gain?game={GAME}"), CALL_TIMEOUT)?;
    let rows = rows_of(status, &body)?;
    Ok(serde_json::json!({ "relay": r.id, "game": GAME, "bar_ms": AUTO_MIN_GAIN_MS, "rows": rows }))
}

/// The relay card's line about this machine's ISP network. Uses the last table for up to an hour
/// unless `refresh` (a new match was logged). None when the tunnel's relay has no API.
#[tauri::command]
pub async fn relay_gain(app: tauri::AppHandle, refresh: Option<bool>) -> Result<Option<GainView>, String> {
    use tauri::Manager;
    let dir = crate::app_dir(&app);
    let db = app.state::<crate::geoip::GeoDb>().current();
    crate::relay::blocking(move || {
        let Some((id, _)) = active_joined(&dir)? else { return Ok(None) };
        let cached = load(&dir).filter(|t| t.relay == id);
        if let Some(t) = cached.as_ref().filter(|t| !refresh.unwrap_or(false) && crate::relay::now_ms().saturating_sub(t.fetched_ms) < TABLE_TTL_MS) {
            return Ok(Some(view(t)));
        }
        match sync_blocking(&dir, db.as_deref()) {
            Ok(t) => Ok(t.as_ref().map(view)),
            // The last table beats none while the relay or the network is unreachable.
            Err(e) => cached.map(|t| Some(view(&t))).ok_or(e),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn net(region: Option<&str>) -> Network {
        Network { asn: 64496, isp: Some("Example Cable Communications, LLC".into()), region: region.map(String::from) }
    }

    fn m(id: &str, path: &str, median: f64, loss: f64) -> MatchPing {
        MatchPing { v: 1, id: id.into(), ts: 0, path: path.into(), samples: 60, min_ms: median, median_ms: median, p95_ms: median, jitter_ms: None, loss, duration_s: 1500.0 }
    }

    fn row(source: &str, region: Option<&str>, players: usize, gain: f64, gaining: usize) -> Row {
        Row { source: source.into(), asn: 64496, region: region.map(String::from), players, median_gain_ms: gain, gaining, median_direct_ms: 40.0, median_relay_ms: 40.0 - gain }
    }

    fn table(rows: Vec<Row>, region: Option<&str>) -> Table {
        Table { relay: "relay-chi-1".into(), network: net(region), rows, fetched_ms: 1, sent: false }
    }

    #[test]
    fn reads_the_network_from_a_geoip_answer() {
        let g = |asn: Option<&str>, region: Option<&str>, country: Option<&str>| crate::Geo {
            query: "self".into(),
            status: "success".into(),
            city: Some("Pittsburgh".into()),
            region: region.map(String::from),
            country: country.map(String::from),
            lat: None,
            lon: None,
            isp: Some("Example Cable".into()),
            asn: asn.map(String::from),
        };
        let n = network_of(&g(Some("AS64496 Example Cable"), Some("Pennsylvania"), Some("United States"))).unwrap();
        assert_eq!((n.asn, n.region.as_deref(), n.isp.as_deref()), (64496, Some("Pennsylvania, United States"), Some("Example Cable")));
        assert_eq!(network_of(&g(Some("AS64496"), None, Some("Germany"))).unwrap().region.as_deref(), Some("Germany"), "country only");
        assert_eq!(network_of(&g(Some("AS64496"), Some("<b>"), Some("United States"))).unwrap().region, None, "the relay would refuse it");
        assert!(network_of(&g(None, None, None)).is_none());
        assert!(network_of(&g(Some("AS0"), None, None)).is_none());
        assert!(network_of(&g(Some("7922"), None, None)).is_none());
    }

    #[test]
    fn network_from_the_db_ip_shaped_fixture() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let db = OfflineDb::open_files(&dir.join("geoip-city-test.mmdb"), Some(&dir.join("geoip-asn-test.mmdb"))).unwrap();
        let n = network_of(&db.lookup("self", "198.51.100.7".parse().unwrap()).unwrap()).unwrap();
        assert_eq!(n, Network { asn: 6507, isp: Some("Riot Games, Inc".into()), region: Some("Illinois, United States".into()) });
        assert_eq!(network_label(&n), "Riot Games (AS6507)");
    }

    #[test]
    fn region_follows_the_relays_rule() {
        assert!(valid_region("Pennsylvania, United States"));
        assert!(valid_region("Provence-Alpes-Côte d'Azur, France"));
        for bad in ["", " Ohio", "Ohio ", "a\nb", "a\u{a0}b", "<b>", "x\"y", "back\\slash", &"x".repeat(65)] {
            assert!(!valid_region(bad), "{bad:?}");
        }
    }

    #[test]
    fn in_game_report_needs_three_matches_on_each_path() {
        let mut log = vec![m("01", "direct", 44.0, 0.0), m("02", "direct", 46.0, 0.002), m("03", "relay-chi-1", 31.0, 0.0), m("04", "relay-chi-1", 30.0, 0.0), m("05", "relay-chi-1", 33.0, 0.001)];
        assert!(in_game(&log, "relay-chi-1", &net(None)).is_none(), "2 direct");
        log.push(m("06", MIXED, 10.0, 0.0));
        log.push(m("07", "unknown", 90.0, 0.0));
        assert!(in_game(&log, "relay-chi-1", &net(None)).is_none(), "mixed and unknown matches count on no path");
        log.push(m("08", "direct", 45.0, 0.001));
        let r = in_game(&log, "relay-chi-1", &net(Some("Ohio, United States"))).unwrap();
        assert_eq!((r.direct_ms, r.relay_ms, r.direct_n, r.relay_n), (45.0, 31.0, 3, 3));
        assert_eq!((r.direct_loss, r.relay_loss), (Some(0.001), Some(0.0)));
        assert_eq!((r.source.as_str(), r.game.as_str(), r.asn, r.region.as_deref()), ("in_game", "league", 64496, Some("Ohio, United States")));
        assert!(in_game(&log, "other-relay", &net(None)).is_none(), "only matches on this relay");
        assert!(in_game(&log, "direct", &net(None)).is_none());
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("\"id\"") && !json.contains("\"ts\""), "no match ids or times leave the machine: {json}");
    }

    #[test]
    fn in_game_report_reads_the_newest_ten_per_path() {
        let mut log: Vec<MatchPing> = (0..12).map(|i| m(&format!("2026-11-{i:02}"), "direct", if i < 2 { 90.0 } else { 40.0 }, 0.0)).collect();
        log.extend((0..3).map(|i| m(&format!("2026-11-{:02}", 20 + i), "relay-chi-1", 30.0, 0.0)));
        let r = in_game(&log, "relay-chi-1", &net(None)).unwrap();
        assert_eq!((r.direct_n, r.direct_ms), (10, 40.0), "the two oldest (slow) matches fall out");
    }

    #[test]
    fn view_quotes_in_game_first_then_estimates_then_counts() {
        let pa = Some("Pennsylvania, United States");
        let rows = vec![row("estimate", None, 6, 9.0, 2), row("in_game", None, 5, 12.0, 3), row("in_game", pa, 3, 13.5, 2)];
        let v = view(&table(rows.clone(), pa));
        assert_eq!(v.text, "Players on Example Cable Communications (AS64496) in Pennsylvania gain 14 ms in game with relay-chi-1: 3 players, 2 by 10 ms or more.");
        assert_eq!((v.kind.as_str(), v.source.as_deref(), v.players, v.median_gain_ms), ("gain", Some("in_game"), 3, Some(13.5)));

        let v = view(&table(rows.clone(), Some("Ohio, United States")));
        assert_eq!(v.text, "Players on Example Cable Communications (AS64496) gain 12 ms in game with relay-chi-1: 5 players, 3 by 10 ms or more.");

        let v = view(&table(vec![row("estimate", None, 6, 9.0, 2), row("in_game", None, 2, 30.0, 2)], None));
        assert_eq!(v.text, "Gain checks by 6 players on Example Cable Communications (AS64496) estimate they gain 9 ms with relay-chi-1. Not yet measured in game.");
        assert_eq!((v.kind.as_str(), v.source.as_deref()), ("none", Some("estimate")));

        let v = view(&table(vec![row("in_game", None, 2, 30.0, 2)], None));
        assert_eq!(v.text, "Players on Example Cable Communications (AS64496): relay-chi-1 measured in game by 2 of the 3 players needed.");
        assert_eq!((v.kind.as_str(), v.source, v.players, v.median_gain_ms), ("few", None, 2, None));
        assert!(view(&table(vec![], None)).text.ends_with("by 0 of the 3 players needed."));
    }

    #[test]
    fn view_says_lose_and_nothing_plainly() {
        let v = view(&table(vec![row("in_game", None, 4, -12.0, 0)], None));
        assert!(v.text.contains(" lose 12 ms in game"), "{}", v.text);
        assert_eq!(v.kind, "worse");
        let v = view(&table(vec![row("in_game", None, 4, 0.2, 0)], None));
        assert!(v.text.contains(" gain nothing in game"), "{}", v.text);
        assert_eq!(v.kind, "none");
        let mut t = table(vec![row("in_game", None, 4, 3.0, 0)], None);
        t.network.isp = None;
        assert!(view(&t).text.starts_with("Players on AS64496 gain 3 ms"), "{}", view(&t).text);
        // Another network's rows never answer for this one.
        let mut other = row("in_game", None, 9, 20.0, 9);
        other.asn = 64497;
        assert_eq!(view(&table(vec![other], None)).kind, "few");
    }

    #[test]
    fn rows_parse_from_the_relay_answer() {
        let body = serde_json::json!({"game": "league", "bar_ms": 10, "rows": [
            {"source": "in_game", "asn": 64496, "region": null, "players": 4, "median_gain_ms": 12.0, "gaining": 3, "median_direct_ms": 44.0, "median_relay_ms": 32.0}
        ]});
        let rows = rows_of(200, &body).unwrap();
        assert_eq!((rows.len(), rows[0].players, rows[0].region.clone()), (1, 4, None));
        assert!(rows_of(404, &serde_json::json!({"error": "not found"})).unwrap_err().contains("needs an update"));
        assert!(rows_of(401, &serde_json::Value::Null).unwrap_err().contains("no longer accepts"));
        assert!(rows_of(200, &serde_json::json!({"rows": [{"source": "x"}]})).is_err());
    }

    #[test]
    fn table_round_trips_on_disk() {
        let d = std::env::temp_dir().join(format!("rd-gain-{}-{}", std::process::id(), crate::relay::now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        assert!(load(&d).is_none());
        let t = table(vec![row("in_game", None, 4, 12.0, 3)], Some("Ohio, United States"));
        store(&d, &t);
        assert_eq!(load(&d), Some(t));
        std::fs::remove_dir_all(d).unwrap();
    }
}
