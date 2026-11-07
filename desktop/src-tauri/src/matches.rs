//! In-game ping from League's own match logs. During a match the game writes
//! `Logs/GameLogs/<start>/<start>_netstats.csv` every 10 s, with the round trip to the game server
//! measured by the game itself (`network.rtt_average`, seconds). That is the one number outside
//! pings can't get, since Riot game servers drop ICMP. After each match this reads the file, keeps
//! the ping, jitter and loss, tags the match with the path game traffic took (direct or a relay's
//! name, noted while the match ran) and appends it to `match-log.jsonl`. Only numbers are kept:
//! not the server address, not the player id.

use crate::proof::quantile;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const MATCH_LOG: &str = "match-log.jsonl";
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
    /// "direct", a saved relay's name, or "unknown" when the app wasn't running during the match.
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

/// The game's numbers from a netstats.csv. Columns are found by header name, so a reordered or
/// longer header still reads. Only rows marked Connected count.
pub fn parse_netstats(text: &str) -> Option<(Vec<f64>, Vec<f64>, u64, u64, f64)> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let head: Vec<&str> = lines.next()?.split(',').map(str::trim).collect();
    let col = |name: &str| head.iter().position(|h| *h == name);
    let (rtt, jit, lost, sent, status, time) = (col("network.rtt_average")?, col("network.rtt_jitter"), col("network.packets_lost"), col("network.packets_sent"), col("network.status"), col("game.time"));
    let (mut rtts, mut jitters, mut lost_n, mut sent_n, mut last_t) = (Vec::new(), Vec::new(), 0u64, 0u64, 0.0f64);
    for l in lines {
        let f: Vec<&str> = l.split(',').map(str::trim).collect();
        let get = |i: Option<usize>| i.and_then(|i| f.get(i).copied());
        if get(status).is_some_and(|s| s != "Connected") {
            continue;
        }
        let Some(r) = get(Some(rtt)).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite() && *v > 0.0 && *v < 5.0) else { continue };
        rtts.push(round1(r * 1000.0));
        if let Some(j) = get(jit).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite() && *v >= 0.0) {
            jitters.push(round1(j * 1000.0));
        }
        // Per-interval counts, so they add up over the match.
        lost_n += get(lost).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        sent_n += get(sent).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        if let Some(t) = get(time).and_then(|v| v.parse::<f64>().ok()) {
            last_t = last_t.max(t);
        }
    }
    (!rtts.is_empty()).then_some((rtts, jitters, lost_n, sent_n, last_t))
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
        if let Some(name) = folders.last().and_then(|f| f.file_name()).map(|n| n.to_string_lossy().into_owned()) {
            if !paths.contains_key(&name) {
                paths.insert(name, current_path(dir));
                write_paths(dir, &paths)?;
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
        }
    }
    Ok(IngestResult { added, last: read_log(dir).into_iter().max_by(|a, b| a.id.cmp(&b.id)) })
}

#[tauri::command]
pub async fn match_ingest(app: tauri::AppHandle) -> Result<IngestResult, String> {
    let dir = crate::app_dir(&app);
    crate::relay::blocking(move || ingest(&dir, crate::relay::now_ms(), crate::relay::game_running(crate::relay::DEFAULT_GAME).is_some())).await
}

// ---------- month view ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MatchMonth {
    pub direct: usize,
    pub relay: usize,
    pub direct_median_ms: Option<f64>,
    pub relay_median_ms: Option<f64>,
}

/// Matches in a month split by path, with the median of each match's median ping.
pub fn month_split(ms: &[&MatchPing]) -> MatchMonth {
    let med = |mut v: Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (!v.is_empty()).then(|| round1(quantile(&v, 0.5)))
    };
    let d: Vec<f64> = ms.iter().filter(|m| m.path == "direct").map(|m| m.median_ms).collect();
    let r: Vec<f64> = ms.iter().filter(|m| m.path != "direct" && m.path != "unknown").map(|m| m.median_ms).collect();
    MatchMonth { direct: d.len(), relay: r.len(), direct_median_ms: med(d), relay_median_ms: med(r) }
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
    fn month_split_keeps_paths_apart() {
        let m = |path: &str, med: f64| MatchPing { v: 1, id: "a".into(), ts: 0, path: path.into(), samples: 10, min_ms: med, median_ms: med, p95_ms: med, jitter_ms: None, loss: 0.0, duration_s: 600.0 };
        let all = [m("direct", 32.0), m("direct", 34.0), m("relay-chi-1", 28.0), m("unknown", 90.0)];
        let s = month_split(&all.iter().collect::<Vec<_>>());
        assert_eq!((s.direct, s.relay), (2, 1));
        assert_eq!(s.direct_median_ms, Some(33.0));
        assert_eq!(s.relay_median_ms, Some(28.0));
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
