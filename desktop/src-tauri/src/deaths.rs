//! The player's own deaths in a match, for the replay. Riot's Live Client Data API is served by
//! the game itself on loopback, and only while a match runs, so a background thread reads it
//! during play and keeps the times for afterwards. Nothing about a death is shown while the match
//! runs: only the replay reads this file, and the replay opens only matches already in the match
//! log. Only game-clock seconds are kept, not names.

use crate::matches::NetSample;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Match folder -> the player's deaths, game-clock seconds in order. A match with no entry wasn't
/// read; an empty list means it was read and the player never died.
const DEATHS_FILE: &str = "match-deaths.json";
const API: &str = "https://127.0.0.1:2999/liveclientdata";
/// The API keeps the whole match's events, so a missed read loses nothing unless it is the last.
const POLL: Duration = Duration::from_secs(5);
/// Matches remembered, the newest kept.
const KEEP: usize = 300;
/// A netstats file this recently written belongs to the match running now, not the one before it.
const FRESH: Duration = Duration::from_secs(120);
/// The game writes a line about every 10 s, so a death further than this from any line has no reading.
const LINE_S: f64 = 12.0;

/// One death in a finished match, pinned to the netstats line covering it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Death {
    /// Game clock, seconds.
    pub t: f64,
    /// Index of the line in the match's series, and that line's ping. None when no line is close.
    pub at: Option<usize>,
    pub ms: Option<f64>,
}

/// The same player, from names that may or may not carry a `#TAG`: the event list has used plain
/// names while the active player's name can be a full Riot ID.
fn same_player(a: &str, b: &str) -> bool {
    let full = |s: &str| s.trim().to_lowercase();
    let name = |s: &str| full(s.split('#').next().unwrap_or(s));
    if a.contains('#') && b.contains('#') {
        full(a) == full(b)
    } else {
        name(a) == name(b)
    }
}

/// Game-clock seconds of every `ChampionKill` in the API's event list whose victim is `me`.
pub fn my_deaths(events: &serde_json::Value, me: &str) -> Vec<f64> {
    events["Events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["EventName"] == "ChampionKill" && e["VictimName"].as_str().is_some_and(|v| same_player(v, me)))
        .filter_map(|e| e["EventTime"].as_f64())
        .map(|t| (t * 10.0).round() / 10.0)
        .collect()
}

/// Each death with the line covering it: the first line at or after it, else the last line when
/// the match ended before another was written. A line without a game clock counts 10 s each.
pub fn pin(samples: &[NetSample], times: &[f64]) -> Vec<Death> {
    let clock = |i: usize| samples[i].t.unwrap_or((i + 1) as f64 * 10.0);
    times
        .iter()
        .map(|&t| {
            let after = (0..samples.len()).find(|&i| clock(i) >= t).filter(|&i| clock(i) - t <= LINE_S);
            let at = after.or_else(|| samples.len().checked_sub(1).filter(|&i| clock(i) < t && t - clock(i) <= LINE_S));
            Death { t, at, ms: at.map(|i| samples[i].ms) }
        })
        .collect()
}

pub fn read(dir: &Path) -> BTreeMap<String, Vec<f64>> {
    std::fs::read_to_string(dir.join(DEATHS_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Keeps a read of match `id`. A match's list only grows, so a shorter read changes nothing. The
/// file is written beside the target and renamed over it, so a crash never leaves half of it.
fn remember(dir: &Path, id: &str, times: Vec<f64>) -> Result<(), String> {
    let mut all = read(dir);
    if all.get(id).is_some_and(|old| old.len() >= times.len()) {
        return Ok(());
    }
    all.insert(id.into(), times);
    while all.len() > KEEP {
        all.pop_first();
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{DEATHS_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_string(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(DEATHS_FILE)).map_err(|e| e.to_string())
}

/// The running match's folder name, once its netstats file shows the game is writing it.
fn running_id() -> Option<String> {
    let folder = crate::matches::match_dirs().pop()?;
    let age = std::fs::metadata(crate::matches::netstats_in(&folder)?).ok()?.modified().ok().and_then(|t| SystemTime::now().duration_since(t).ok())?;
    (age <= FRESH).then(|| folder.file_name().map(|n| n.to_string_lossy().into_owned()))?
}

async fn get(client: &reqwest::Client, path: &str) -> Option<serde_json::Value> {
    client.get(format!("{API}/{path}")).send().await.ok()?.error_for_status().ok()?.json().await.ok()
}

/// Reads the running match every few seconds for as long as the app is open. Between matches the
/// game's API isn't there and the read fails at once.
pub fn watch(dir: PathBuf) {
    std::thread::spawn(move || {
        // The game serves its API on loopback with a self-signed certificate.
        let Ok(client) = reqwest::Client::builder().danger_accept_invalid_certs(true).timeout(Duration::from_secs(1)).build() else { return };
        loop {
            std::thread::sleep(POLL);
            let read_now = tauri::async_runtime::block_on(async {
                let me = get(&client, "activeplayername").await?;
                let events = get(&client, "eventdata").await?;
                Some(my_deaths(&events, me.as_str()?))
            });
            let Some(times) = read_now else { continue };
            let Some(id) = running_id() else { continue };
            if let Err(e) = remember(&dir, &id, times) {
                eprintln!("match deaths: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(t: Option<f64>, ms: f64) -> NetSample {
        NetSample { t, ms, jitter_ms: None, lost: 0, sent: 100 }
    }

    #[test]
    fn my_deaths_keeps_only_my_champion_kills() {
        let ev = json!({ "Events": [
            { "EventID": 0, "EventName": "GameStart", "EventTime": 0.03 },
            { "EventID": 1, "EventName": "ChampionKill", "EventTime": 612.46, "VictimName": "Riot Gene", "KillerName": "Riot Tuxedo", "Assisters": [] },
            { "EventID": 2, "EventName": "ChampionKill", "EventTime": 700.0, "VictimName": "Riot Tuxedo", "KillerName": "Riot Gene", "Assisters": ["Player 1"] },
            { "EventID": 3, "EventName": "TurretKilled", "EventTime": 800.0, "VictimName": "Riot Gene" },
            { "EventID": 4, "EventName": "ChampionKill", "EventTime": 912.44, "VictimName": "riot gene", "KillerName": "Turret_T1_L_03_A" },
        ] });
        assert_eq!(my_deaths(&ev, "Riot Gene"), [612.5, 912.4]);
        assert_eq!(my_deaths(&ev, "Riot Gene#NA1"), [612.5, 912.4], "the event list has no tag");
        assert_eq!(my_deaths(&ev, "Nobody"), [] as [f64; 0]);
        assert_eq!(my_deaths(&json!({ "errorCode": "RESOURCE_NOT_FOUND" }), "Riot Gene"), [] as [f64; 0]);
    }

    #[test]
    fn players_are_told_apart_by_tag_when_both_names_have_one() {
        assert!(same_player("Riot Gene#NA1", "riot gene#na1"));
        assert!(!same_player("Riot Gene#NA1", "Riot Gene#EUW"));
        assert!(same_player("Riot Gene", "Riot Gene#EUW"));
        assert!(!same_player("Riot Gene", "Riot Genie"));
    }

    #[test]
    fn a_death_takes_the_line_covering_it() {
        let s = [line(Some(10.0), 30.0), line(Some(20.0), 88.0), line(Some(50.0), 31.0)];
        assert_eq!(pin(&s, &[14.2]), [Death { t: 14.2, at: Some(1), ms: Some(88.0) }]);
        assert_eq!(pin(&s, &[20.0]), [Death { t: 20.0, at: Some(1), ms: Some(88.0) }], "on a line");
        assert_eq!(pin(&s, &[30.0]), [Death { t: 30.0, at: None, ms: None }], "the game wrote no line near it");
        assert_eq!(pin(&s, &[55.0]), [Death { t: 55.0, at: Some(2), ms: Some(31.0) }], "after the last line, close to it");
        assert_eq!(pin(&s, &[80.0]), [Death { t: 80.0, at: None, ms: None }], "long after the last line");
        assert_eq!(pin(&[], &[5.0]), [Death { t: 5.0, at: None, ms: None }]);
        assert_eq!(pin(&[line(None, 40.0), line(None, 50.0)], &[12.0])[0].at, Some(1), "no clock: 10 s a line");
    }

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("rig-deaths-{}-{}", std::process::id(), crate::relay::now_ms()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_match_keeps_its_longest_read_and_old_matches_drop_off() {
        let dir = temp_dir();
        assert!(read(&dir).is_empty(), "nothing read yet");
        remember(&dir, "m1", vec![]).unwrap();
        assert_eq!(read(&dir).get("m1"), Some(&vec![]), "read, no deaths");
        remember(&dir, "m1", vec![10.0, 20.0]).unwrap();
        remember(&dir, "m1", vec![10.0]).unwrap();
        assert_eq!(read(&dir)["m1"], [10.0, 20.0], "a shorter read changes nothing");
        for i in 0..KEEP {
            remember(&dir, &format!("n{i:04}"), vec![]).unwrap();
        }
        let all = read(&dir);
        assert_eq!(all.len(), KEEP);
        assert!(!all.contains_key("m1"), "ids sort by start time, the oldest goes");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
