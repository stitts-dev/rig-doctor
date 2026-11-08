//! In-game ping from League's own match logs. During a match the game writes
//! `Logs/GameLogs/<start>/<start>_netstats.csv` every 10 s, with the round trip to the game server
//! measured by the game itself (`network.rtt_average`, seconds). That is the one number outside
//! pings can't get, since Riot game servers drop ICMP. After each match this reads the file, keeps
//! the ping, jitter and loss, tags the match with the path game traffic took (direct or a relay's
//! name, noted while the match ran) and appends it to `match-log.jsonl`. Only numbers are kept
//! there: not the server address, not the player id. The server's /24 goes to `game-ranges.json`
//! (game_ranges.rs) so the tunnel carries it. A match on a server outside the tunnel's ranges went
//! direct, so it is tagged direct even with the tunnel on. A match whose path changed while it ran
//! (the relay turned on, off, or to another relay mid-match) is tagged `mixed` and left out of
//! Auto's pick and the refund verdict, since it measured neither path alone.

use crate::proof::quantile;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MATCH_LOG: &str = "match-log.jsonl";
/// The path tag of a match that ran on more than one path.
pub const MIXED: &str = "mixed";
/// Match folder -> path, noted while each match runs.
const PATHS_FILE: &str = "match-paths.json";
/// A netstats file untouched this long belongs to a finished match.
const SETTLED_MS: u64 = 120_000;
/// Fewer connected samples than this (under a minute of play) isn't a match worth judging.
const MIN_SAMPLES: usize = 6;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MatchPing {
    pub v: u32,
    /// The match's log folder name, its local start time: "2026-11-07T07-01-06".
    pub id: String,
    /// When it was read, ms since the epoch.
    pub ts: u64,
    /// "direct", a saved relay's name, "mixed" when the path changed mid-match, or "unknown" when
    /// the app wasn't running during the match.
    pub path: String,
    pub samples: usize,
    pub min_ms: f64,
    pub median_ms: f64,
    pub p95_ms: f64,
    /// Median of the game's own jitter readings.
    pub jitter_ms: Option<f64>,
    /// Packets lost over packets sent, 0 to 1.
    pub loss: f64,
    pub duration_s: f64,
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// One 10 s line of a match's netstats.csv: the game's own numbers, and nothing that names the
/// server or the player.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NetSample {
    /// Game clock, seconds, when the line has one.
    pub t: Option<f64>,
    /// Round trip to the game server, ms.
    pub ms: f64,
    pub jitter_ms: Option<f64>,
    /// Packets lost and sent in this line's 10 s.
    pub lost: u64,
    pub sent: u64,
}

/// Every line of a netstats.csv the game marked Connected with a usable round trip, in order: the
/// one reader behind a match's summary, the live match and the replay. Columns are found by header
/// name, so a reordered or longer header still reads.
pub fn series(text: &str) -> Vec<NetSample> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let Some(head) = lines.next() else { return Vec::new() };
    let head: Vec<&str> = head.split(',').map(str::trim).collect();
    let col = |name: &str| head.iter().position(|h| *h == name);
    let Some(rtt) = col("network.rtt_average") else { return Vec::new() };
    let (jit, lost, sent, status, time) = (col("network.rtt_jitter"), col("network.packets_lost"), col("network.packets_sent"), col("network.status"), col("game.time"));
    lines
        .filter_map(|l| {
            let f: Vec<&str> = l.split(',').map(str::trim).collect();
            let get = |i: Option<usize>| i.and_then(|i| f.get(i).copied());
            if get(status).is_some_and(|s| s != "Connected") {
                return None;
            }
            let r = get(Some(rtt)).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite() && *v > 0.0 && *v < 5.0)?;
            Some(NetSample {
                t: get(time).and_then(|v| v.parse::<f64>().ok()),
                ms: round1(r * 1000.0),
                jitter_ms: get(jit).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite() && *v >= 0.0).map(|j| round1(j * 1000.0)),
                // Per-interval counts, so they add up over the match.
                lost: get(lost).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0),
                sent: get(sent).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0),
            })
        })
        .collect()
}

/// The game's numbers from a netstats.csv, over its connected lines: round trips, jitters, packets
/// lost and sent, and the last game clock.
pub fn parse_netstats(text: &str) -> Option<(Vec<f64>, Vec<f64>, u64, u64, f64)> {
    let rows = series(text);
    (!rows.is_empty()).then(|| {
        (
            rows.iter().map(|s| s.ms).collect(),
            rows.iter().filter_map(|s| s.jitter_ms).collect(),
            rows.iter().map(|s| s.lost).sum(),
            rows.iter().map(|s| s.sent).sum(),
            rows.iter().filter_map(|s| s.t).fold(0.0, f64::max),
        )
    })
}

/// Lines in a minute of play: the game writes one every 10 s.
const MINUTE: usize = 6;

/// A match's worst minute: the six lines in a row with the highest in-game score, scored as Auto
/// scores a path (ping plus 3 ms per 1% lost).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Worst {
    /// Index of its first and last line in the series.
    pub from: usize,
    pub to: usize,
    /// Its mean ping, ms.
    pub ms: f64,
    pub lost: u64,
}

pub fn worst_minute(s: &[NetSample]) -> Option<Worst> {
    let score = |x: &NetSample| x.ms + crate::route_auto::LOSS_MS_PER_PCT * if x.sent > 0 { x.lost as f64 * 100.0 / x.sent as f64 } else { 0.0 };
    let (from, _) = s.windows(MINUTE).enumerate().map(|(i, w)| (i, w.iter().map(score).sum::<f64>())).fold(None, |best: Option<(usize, f64)>, (i, v)| match best {
        Some((_, b)) if b >= v => best,
        _ => Some((i, v)),
    })?;
    let w = &s[from..from + MINUTE];
    Some(Worst { from, to: from + MINUTE - 1, ms: round1(w.iter().map(|x| x.ms).sum::<f64>() / MINUTE as f64), lost: w.iter().map(|x| x.lost).sum() })
}

/// One match's summary, or None when it has too few samples to judge.
pub fn summarize(id: &str, ts: u64, path: &str, text: &str) -> Option<MatchPing> {
    let (mut rtts, mut jitters, lost, sent, dur) = parse_netstats(text)?;
    if rtts.len() < MIN_SAMPLES {
        return None;
    }
    rtts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    jitters.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let loss = if sent > 0 { (lost as f64 / sent as f64).min(1.0) } else { 0.0 };
    Some(MatchPing {
        v: 1,
        id: id.into(),
        ts,
        path: path.into(),
        samples: rtts.len(),
        min_ms: rtts[0],
        median_ms: round1(quantile(&rtts, 0.5)),
        p95_ms: round1(quantile(&rtts, 0.95)),
        jitter_ms: (!jitters.is_empty()).then(|| round1(quantile(&jitters, 0.5))),
        loss: (loss * 1000.0).round() / 1000.0,
        duration_s: dur.round(),
    })
}

// ---------- files ----------

pub fn read_log(dir: &Path) -> Vec<MatchPing> {
    std::fs::read_to_string(dir.join(MATCH_LOG)).map(|t| t.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()).unwrap_or_default()
}

fn append(dir: &Path, m: &MatchPing) -> Result<(), String> {
    use std::io::Write;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let line = serde_json::to_string(m).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(MATCH_LOG)).map_err(|e| e.to_string())?;
    f.write_all(format!("{line}\n").as_bytes()).map_err(|e| e.to_string())
}

fn read_paths(dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(dir.join(PATHS_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn write_paths(dir: &Path, m: &BTreeMap<String, String>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(PATHS_FILE), serde_json::to_string(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Match folders under every League install, newest last.
fn match_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = crate::league_install_dirs()
        .iter()
        .flat_map(|i| crate::platform::league_game_log_dirs(i))
        .flat_map(|g| std::fs::read_dir(g).into_iter().flatten().flatten())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    out.sort_by_key(|p| p.file_name().map(|n| n.to_os_string()));
    out
}

fn netstats_in(folder: &Path) -> Option<PathBuf> {
    std::fs::read_dir(folder).ok()?.flatten().map(|e| e.path()).find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().ends_with("_netstats.csv")))
}

/// The server address from netstats' `network.peer_address` column (last row that has one), with
/// or without a port.
pub fn parse_peer(text: &str) -> Option<IpAddr> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let col = lines.next()?.split(',').map(str::trim).position(|h| h == "network.peer_address")?;
    lines.rev().filter_map(|l| l.split(',').nth(col).map(str::trim)).find_map(|v| v.parse::<IpAddr>().ok().or_else(|| v.rsplit_once(':')?.0.parse().ok()))
}

/// The game server a match joined: the last "Connecting to address" in its r3dlog, else the
/// netstats peer address.
fn match_server(folder: &Path) -> Option<IpAddr> {
    let files: Vec<PathBuf> = std::fs::read_dir(folder).ok()?.flatten().map(|e| e.path()).collect();
    let named = |end: &str| files.iter().find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().ends_with(end)));
    named("_r3dlog.txt")
        .and_then(|p| read_shared(p))
        .and_then(|t| t.lines().rev().find_map(crate::parse_league_connect))
        .and_then(|(ip, _)| ip.parse().ok())
        .or_else(|| named("_netstats.csv").and_then(|p| read_shared(p)).and_then(|t| parse_peer(&t)))
}

/// The path to note for a match on `server`: direct when the tunnel's ranges don't hold it, since
/// the split tunnel then sends the game direct.
pub fn path_for_server(noted: &str, tunnel: Option<&crate::relay::WgConfig>, server: &IpAddr) -> String {
    match tunnel {
        Some(cfg) if noted != "direct" && noted != "unknown" && noted != MIXED && !crate::relay::routes_via_tunnel(cfg, server) => "direct".into(),
        _ => noted.into(),
    }
}

/// Running matches whose server was already checked against the tunnel.
static CHECKED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Reads without locking the game out of its own file.
fn read_shared(p: &Path) -> Option<String> {
    std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// The path game traffic takes right now: the active relay's name when the tunnel is up.
fn current_path(dir: &Path) -> String {
    if crate::relay::tunnel_state(dir) == crate::relay::TunnelState::Up {
        crate::relay::list(dir).and_then(|l| crate::relay::active_id(dir, &l)).ok().flatten().unwrap_or_else(|| "relay".into())
    } else {
        "direct".into()
    }
}

/// The path the running match's traffic takes right now, given its server when known.
fn live_path(dir: &Path, folder: &Path) -> String {
    let now = current_path(dir);
    match match_server(folder) {
        Some(server) => path_for_server(&now, crate::relay::load(dir).ok().flatten().as_ref(), &server),
        None => now,
    }
}

/// A League match in progress: its folder and the path its traffic takes now. None outside a match.
pub fn running_match(dir: &Path) -> Option<(PathBuf, String)> {
    crate::relay::game_running(crate::relay::DEFAULT_GAME)?;
    let folder = match_dirs().pop()?;
    let path = live_path(dir, &folder);
    Some((folder, path))
}

/// Tags match `name` mixed when its path went from `was` to `now`. True when it changed.
pub fn mark_mixed(paths: &mut BTreeMap<String, String>, name: &str, was: &str, now: &str) -> bool {
    if was == now || paths.get(name).is_some_and(|p| p == MIXED) {
        return false;
    }
    paths.insert(name.into(), MIXED.into());
    true
}

/// After the user turned the relay on, off, or to another relay: the match that was running
/// (`before`, from [`running_match`]) is tagged mixed when its path changed.
pub fn note_switch(dir: &Path, before: Option<(PathBuf, String)>) {
    let Some((folder, was)) = before else { return };
    let Some(name) = folder.file_name().map(|n| n.to_string_lossy().into_owned()) else { return };
    let now = live_path(dir, &folder);
    let mut paths = read_paths(dir);
    if mark_mixed(&mut paths, &name, &was, &now) {
        if let Err(e) = write_paths(dir, &paths) {
            eprintln!("match paths: {e}");
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct IngestResult {
    /// Matches read this time.
    pub added: Vec<MatchPing>,
    /// The newest match on record.
    pub last: Option<MatchPing>,
}

/// One pass: while a match runs, note its path; once it has ended, read every finished match not
/// yet on record. Only files under the League install are read, nothing there is changed.
pub fn ingest(dir: &Path, now_ms: u64, game_running: bool) -> Result<IngestResult, String> {
    let folders = match_dirs();
    let mut paths = read_paths(dir);
    if game_running {
        if let Some((folder, name)) = folders.last().and_then(|f| Some((f, f.file_name()?.to_string_lossy().into_owned()))) {
            if !paths.contains_key(&name) {
                paths.insert(name.clone(), current_path(dir));
                write_paths(dir, &paths)?;
            }
            let checked = CHECKED.lock().map(|g| g.as_ref().is_some_and(|s| s.contains(&name))).unwrap_or(true);
            if !checked {
                if let Some(server) = match_server(folder) {
                    let noted = paths.get(&name).cloned().unwrap_or_default();
                    let path = path_for_server(&noted, crate::relay::load(dir).ok().flatten().as_ref(), &server);
                    if path != noted {
                        paths.insert(name.clone(), path);
                        write_paths(dir, &paths)?;
                    }
                    if let Ok(mut g) = CHECKED.lock() {
                        g.get_or_insert_with(HashSet::new).insert(name);
                    }
                }
            }
        }
    }
    let have: std::collections::HashSet<String> = read_log(dir).into_iter().map(|m| m.id).collect();
    let mut added = Vec::new();
    // Before the first run there is no note for older matches; only matches after the app knew
    // about them, or the newest few, are read so years of logs aren't pulled in at once.
    let first_run = have.is_empty();
    let skip = if first_run { folders.len().saturating_sub(5) } else { 0 };
    for (i, f) in folders.iter().enumerate().skip(skip) {
        let id = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if have.contains(&id) || (game_running && i + 1 == folders.len()) {
            continue;
        }
        let Some(csv) = netstats_in(f) else { continue };
        let settled = std::fs::metadata(&csv).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).is_some_and(|t| now_ms.saturating_sub(t.as_millis() as u64) >= SETTLED_MS);
        if !settled {
            continue;
        }
        let path = paths.get(&id).cloned().unwrap_or_else(|| "unknown".into());
        if let Some(m) = read_shared(&csv).and_then(|t| summarize(&id, now_ms, &path, &t)) {
            append(dir, &m)?;
            added.push(m);
            // The tunnel carries this server's range from the next time it turns on.
            if let Some(server) = match_server(f) {
                if let Err(e) = crate::game_ranges::learn(dir, &server, now_ms) {
                    eprintln!("game ranges: {e}");
                }
            }
        }
    }
    // Matches read before ranges were learned: take their servers once, so the tunnel can narrow
    // without waiting for the next match.
    if crate::game_ranges::read(dir).is_empty() {
        let logged: HashSet<String> = read_log(dir).into_iter().map(|m| m.id).collect();
        for f in folders.iter().rev().filter(|f| f.file_name().is_some_and(|n| logged.contains(n.to_string_lossy().as_ref()))).take(10) {
            if let Some(server) = match_server(f) {
                crate::game_ranges::learn(dir, &server, now_ms)?;
            }
        }
    }
    Ok(IngestResult { added, last: read_log(dir).into_iter().max_by(|a, b| a.id.cmp(&b.id)) })
}

#[tauri::command]
pub async fn match_ingest(app: tauri::AppHandle) -> Result<IngestResult, String> {
    let dir = crate::app_dir(&app);
    crate::relay::blocking(move || ingest(&dir, crate::relay::now_ms(), crate::relay::game_running(crate::relay::DEFAULT_GAME).is_some())).await
}

// ---------- live match and replay ----------

/// The match running now, as far as the game has written its netstats.
#[derive(Serialize, Clone, Debug)]
pub struct LiveMatch {
    /// Its log folder name, the local time it started.
    pub id: String,
    /// The path its traffic takes now: "direct" or the relay's name.
    pub path: String,
    pub samples: Vec<NetSample>,
    /// Bytes through the tunnel since it came up, received and sent, from the OS's own counters.
    /// Set while the match goes through the relay and the counters can be read.
    pub tunnel_rx: Option<u64>,
    pub tunnel_tx: Option<u64>,
}

pub fn live(dir: &Path) -> Option<LiveMatch> {
    let (folder, path) = running_match(dir)?;
    let id = folder.file_name()?.to_string_lossy().into_owned();
    let samples = netstats_in(&folder).and_then(|p| read_shared(&p)).map(|t| series(&t)).unwrap_or_default();
    let (tunnel_rx, tunnel_tx) = if path == "direct" { (None, None) } else { crate::relay::tunnel_bytes(dir).unzip() };
    Some(LiveMatch { id, path, samples, tunnel_rx, tunnel_tx })
}

#[tauri::command]
pub async fn match_live(app: tauri::AppHandle) -> Result<Option<LiveMatch>, String> {
    let dir = crate::app_dir(&app);
    crate::relay::blocking(move || Ok(live(&dir))).await
}

/// A finished match line by line, for the replay.
#[derive(Serialize, Clone, Debug)]
pub struct MatchSeries {
    pub id: String,
    pub path: String,
    pub samples: Vec<NetSample>,
    pub worst: Option<Worst>,
}

/// Only a match the log holds, found by name among League's own match folders, so the id never
/// becomes a path of its own.
pub fn replay(dir: &Path, id: &str) -> Result<MatchSeries, String> {
    let m = read_log(dir).into_iter().find(|m| m.id == id).ok_or("That match is not in the match log.")?;
    let gone = || "League no longer keeps this match's log.".to_string();
    let folder = match_dirs().into_iter().find(|f| f.file_name().is_some_and(|n| n.to_string_lossy() == id)).ok_or_else(gone)?;
    let samples = series(&netstats_in(&folder).and_then(|p| read_shared(&p)).ok_or_else(gone)?);
    Ok(MatchSeries { id: m.id, path: m.path, worst: worst_minute(&samples), samples })
}

#[tauri::command]
pub async fn match_series(app: tauri::AppHandle, id: String) -> Result<MatchSeries, String> {
    let dir = crate::app_dir(&app);
    crate::relay::blocking(move || replay(&dir, &id)).await
}

/// Matches the replay offers: the newest in the log.
const REPLAYS: usize = 50;

#[tauri::command]
pub async fn match_log(app: tauri::AppHandle) -> Result<Vec<MatchPing>, String> {
    let dir = crate::app_dir(&app);
    crate::relay::blocking(move || {
        let mut log = read_log(&dir);
        log.sort_by(|a, b| b.id.cmp(&a.id));
        log.truncate(REPLAYS);
        Ok(log)
    })
    .await
}

// ---------- month view ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MatchMonth {
    pub direct: usize,
    pub relay: usize,
    /// Matches whose path changed mid-match, judged on neither path.
    pub mixed: usize,
    pub direct_median_ms: Option<f64>,
    pub relay_median_ms: Option<f64>,
}

/// Matches in a month split by path, with the median of each match's median ping. Mixed and
/// unknown matches count on neither path.
pub fn month_split(ms: &[&MatchPing]) -> MatchMonth {
    let med = |mut v: Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (!v.is_empty()).then(|| round1(quantile(&v, 0.5)))
    };
    let d: Vec<f64> = ms.iter().filter(|m| m.path == "direct").map(|m| m.median_ms).collect();
    let r: Vec<f64> = ms.iter().filter(|m| m.path != "direct" && m.path != "unknown" && m.path != MIXED).map(|m| m.median_ms).collect();
    let mixed = ms.iter().filter(|m| m.path == MIXED).count();
    MatchMonth { direct: d.len(), relay: r.len(), mixed, direct_median_ms: med(d), relay_median_ms: med(r) }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic rows in the game's column layout; documentation addresses only.
    const HEAD: &str = "game.time,network.packets_lost,network.packets_sent,network.peer_address,network.rtt_average,network.rtt_jitter,network.status,player.id,";

    fn csv(rows: &[(f64, u64, u64, f64, f64, &str)]) -> String {
        let mut s = format!("{HEAD}\n");
        for (t, lost, sent, rtt, jit, st) in rows {
            s += &format!("{t},{lost},{sent},192.0.2.5,{rtt},{jit},{st},1,\n");
        }
        s
    }

    #[test]
    fn reads_rtt_jitter_and_loss_by_column_name() {
        let rows: Vec<_> = (0..8).map(|i| (i as f64 * 10.0, if i == 3 { 2 } else { 0 }, 100, 0.030 + i as f64 * 0.001, 0.004, "Connected")).collect();
        let m = summarize("2026-11-07T07-01-06", 1, "direct", &csv(&rows)).unwrap();
        assert_eq!(m.samples, 8);
        assert_eq!(m.min_ms, 30.0);
        assert_eq!(m.median_ms, 33.5);
        assert_eq!(m.jitter_ms, Some(4.0));
        assert_eq!(m.loss, 0.003, "2 of 800");
        assert_eq!(m.duration_s, 70.0);
        assert!(!serde_json::to_string(&m).unwrap().contains("192.0.2.5"), "no server address kept");
    }

    #[test]
    fn skips_rows_not_connected_and_short_matches() {
        let mut rows: Vec<_> = (0..6).map(|i| (i as f64, 0, 10, 0.03, 0.0, "Connected")).collect();
        rows.push((7.0, 0, 10, 0.9, 0.0, "Disconnected"));
        assert_eq!(summarize("x", 1, "direct", &csv(&rows)).unwrap().p95_ms, 30.0);
        assert!(summarize("x", 1, "direct", &csv(&rows[..3])).is_none(), "under a minute");
        assert!(summarize("x", 1, "direct", "nonsense\n1,2,3").is_none());
    }

    #[test]
    fn series_keeps_each_connected_line_in_order() {
        let mut rows: Vec<_> = (0..4).map(|i| (i as f64 * 10.0, if i == 2 { 3 } else { 0 }, 100, 0.03 + i as f64 * 0.002, 0.004, "Connected")).collect();
        rows.insert(1, (5.0, 9, 9, 0.5, 0.0, "Disconnected"));
        let s = series(&csv(&rows));
        assert_eq!(s.len(), 4, "the disconnected line is left out");
        assert_eq!(s[2], NetSample { t: Some(20.0), ms: 34.0, jitter_ms: Some(4.0), lost: 3, sent: 100 });
        assert!(!serde_json::to_string(&s).unwrap().contains("192.0.2.5"), "no server address");
        assert!(series("nonsense\n1,2,3").is_empty() && series("").is_empty());
    }

    #[test]
    fn the_worst_minute_is_the_slowest_six_lines_with_loss_counted() {
        let at = |ms: &[f64], lost: &[u64]| ms.iter().zip(lost).enumerate().map(|(i, (m, l))| NetSample { t: Some(i as f64 * 10.0), ms: *m, jitter_ms: None, lost: *l, sent: 100 }).collect::<Vec<_>>();
        assert_eq!(worst_minute(&at(&[30.0; 5], &[0; 5])), None, "under a minute of play");
        let spike = [30.0, 30.0, 30.0, 30.0, 45.0, 45.0, 45.0, 45.0, 30.0, 30.0, 30.0, 30.0];
        assert_eq!(worst_minute(&at(&spike, &[0; 12])), Some(Worst { from: 2, to: 7, ms: 40.0, lost: 0 }), "the first of equal windows");
        let mut lost = [0; 12];
        lost[9] = 5;
        assert_eq!(worst_minute(&at(&[30.0; 12], &lost)), Some(Worst { from: 4, to: 9, ms: 30.0, lost: 5 }), "5% lost weighs 15 ms");
    }

    #[test]
    fn month_split_keeps_paths_apart() {
        let m = |path: &str, med: f64| MatchPing { v: 1, id: "a".into(), ts: 0, path: path.into(), samples: 10, min_ms: med, median_ms: med, p95_ms: med, jitter_ms: None, loss: 0.0, duration_s: 600.0 };
        let all = [m("direct", 32.0), m("direct", 34.0), m("relay-chi-1", 28.0), m("unknown", 90.0), m(MIXED, 10.0), m(MIXED, 12.0)];
        let s = month_split(&all.iter().collect::<Vec<_>>());
        assert_eq!((s.direct, s.relay, s.mixed), (2, 1, 2));
        assert_eq!(s.direct_median_ms, Some(33.0));
        assert_eq!(s.relay_median_ms, Some(28.0));
    }

    #[test]
    fn reads_the_peer_address_with_or_without_port() {
        let rows: Vec<_> = (0..3).map(|i| (i as f64, 0, 10, 0.03, 0.0, "Connected")).collect();
        assert_eq!(parse_peer(&csv(&rows)), Some("192.0.2.5".parse().unwrap()));
        assert_eq!(parse_peer(&csv(&rows).replace("192.0.2.5", "192.0.2.6:7239")), Some("192.0.2.6".parse().unwrap()));
        assert_eq!(parse_peer("game.time,network.rtt_average\n1,0.03\n"), None);
    }

    #[test]
    fn a_server_outside_the_tunnel_tags_the_match_direct() {
        let cfg = crate::relay::parse_config("[Interface]\nPrivateKey = ZGV2aWNla2V5ZGV2aWNla2V5ZGV2aWNla2V5ZGV2aWM=\nAddress = 10.66.66.2/32\n\n[Peer]\nPublicKey = cGxhY2Vob2xkZXJwbGFjZWhvbGRlcnBsYWNlaG9sZGU=\nEndpoint = 203.0.113.10:51820\nAllowedIPs = 10.66.66.1/32, 198.51.100.0/24\n").unwrap();
        let inside: IpAddr = "198.51.100.9".parse().unwrap();
        let outside: IpAddr = "192.0.2.5".parse().unwrap();
        assert_eq!(path_for_server("relay-chi-1", Some(&cfg), &inside), "relay-chi-1");
        assert_eq!(path_for_server("relay-chi-1", Some(&cfg), &outside), "direct");
        assert_eq!(path_for_server("direct", Some(&cfg), &outside), "direct");
        assert_eq!(path_for_server("unknown", Some(&cfg), &outside), "unknown");
        assert_eq!(path_for_server("relay-chi-1", None, &outside), "relay-chi-1");
        assert_eq!(path_for_server(MIXED, Some(&cfg), &outside), MIXED, "a mixed match stays mixed");
    }

    #[test]
    fn a_path_change_mid_match_tags_it_mixed() {
        let mut paths = BTreeMap::from([("m1".to_string(), "direct".to_string())]);
        assert!(!mark_mixed(&mut paths, "m1", "direct", "direct"), "no change, no tag");
        assert_eq!(paths["m1"], "direct");
        assert!(mark_mixed(&mut paths, "m1", "direct", "relay-chi-1"), "relay turned on mid-match");
        assert_eq!(paths["m1"], MIXED);
        assert!(!mark_mixed(&mut paths, "m1", "relay-chi-1", "direct"), "already mixed");
        assert_eq!(paths["m1"], MIXED);
        // Turned off, or moved to another relay, before the first pass noted the match.
        assert!(mark_mixed(&mut paths, "m2", "relay-chi-1", "direct"));
        assert!(mark_mixed(&mut paths, "m3", "relay-chi-1", "relay-ewr-1"));
        assert_eq!((paths["m2"].as_str(), paths["m3"].as_str()), (MIXED, MIXED));
    }

    #[test]
    fn match_log_round_trips() {
        let dir = std::env::temp_dir().join(format!("rig-matches-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let m = summarize("2026-11-07T07-01-06", 5, "relay-chi-1", &csv(&(0..7).map(|i| (i as f64, 0, 10, 0.028, 0.002, "Connected")).collect::<Vec<_>>())).unwrap();
        append(&dir, &m).unwrap();
        assert_eq!(read_log(&dir), vec![m]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
