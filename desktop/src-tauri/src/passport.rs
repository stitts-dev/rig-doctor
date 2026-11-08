//! Everywhere the player's traffic has been: the cities and networks each finished trace crossed
//! and the places a route entered Riot Direct, kept as stamps in `passport.json` so they stay on
//! the globe. Personal bests come from the match log. Stamps hold place and network names, rough
//! coordinates and times, no addresses.

use crate::matches::{read_log, MatchPing, MIXED};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

const FILE: &str = "passport.json";
/// Most stamps of each kind. A full passport keeps what it has and stamps nothing new.
const MAX_EACH: usize = 1000;
/// Longest place or network name kept.
const MAX_NAME: usize = 80;
/// A shorter match, such as a remake, can't set a personal best.
const BEST_MIN_S: f64 = 600.0;
/// One read, merge and write at a time: traces can finish together.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct City {
    pub place: String,
    pub lat: f64,
    pub lng: f64,
    /// When it was first and last crossed, ms since the epoch, and by how many traces.
    pub first: u64,
    pub last: u64,
    pub n: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Network {
    /// The ASN when known, else the name.
    pub id: String,
    pub name: String,
    pub first: u64,
    pub last: u64,
    pub n: u32,
}

/// A place a route entered Riot's network.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RiotEntry {
    pub place: String,
    pub lat: f64,
    pub lng: f64,
    /// The network that handed the traffic over.
    pub from: Option<String>,
    pub first: u64,
    pub last: u64,
    pub n: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Passport {
    #[serde(default)]
    pub cities: Vec<City>,
    #[serde(default)]
    pub networks: Vec<Network>,
    #[serde(default)]
    pub riot: Vec<RiotEntry>,
}

/// What one finished trace crossed.
#[derive(Deserialize, Debug, Default)]
pub struct Stamps {
    #[serde(default)]
    pub cities: Vec<PlaceIn>,
    #[serde(default)]
    pub networks: Vec<NetIn>,
    #[serde(default)]
    pub riot: Vec<EntryIn>,
}

#[derive(Deserialize, Debug)]
pub struct PlaceIn {
    pub place: String,
    pub lat: f64,
    pub lng: f64,
}

#[derive(Deserialize, Debug)]
pub struct NetIn {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Debug)]
pub struct EntryIn {
    pub place: String,
    pub lat: f64,
    pub lng: f64,
    pub from: Option<String>,
}

fn good_name(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= MAX_NAME
}

fn good_spot(lat: f64, lng: f64) -> bool {
    lat.is_finite() && lng.is_finite() && lat.abs() <= 90.0 && lng.abs() <= 180.0
}

/// Adds one finished trace's stamps. A city, network or entry counts once per trace. True when
/// anything changed.
pub fn stamp(p: &mut Passport, s: &Stamps, now_ms: u64) -> bool {
    let mut changed = false;
    let mut seen = HashSet::new();
    for c in s.cities.iter().filter(|c| good_name(&c.place) && good_spot(c.lat, c.lng) && seen.insert(c.place.as_str())) {
        let room = p.cities.len() < MAX_EACH;
        match p.cities.iter_mut().find(|x| x.place == c.place) {
            Some(x) => (x.last, x.n) = (now_ms, x.n.saturating_add(1)),
            None if room => p.cities.push(City { place: c.place.clone(), lat: c.lat, lng: c.lng, first: now_ms, last: now_ms, n: 1 }),
            None => continue,
        }
        changed = true;
    }
    let mut seen = HashSet::new();
    for c in s.networks.iter().filter(|c| good_name(&c.id) && good_name(&c.name) && seen.insert(c.id.as_str())) {
        let room = p.networks.len() < MAX_EACH;
        match p.networks.iter_mut().find(|x| x.id == c.id) {
            Some(x) => (x.name, x.last, x.n) = (c.name.clone(), now_ms, x.n.saturating_add(1)),
            None if room => p.networks.push(Network { id: c.id.clone(), name: c.name.clone(), first: now_ms, last: now_ms, n: 1 }),
            None => continue,
        }
        changed = true;
    }
    let mut seen = HashSet::new();
    for c in s.riot.iter().filter(|c| good_name(&c.place) && good_spot(c.lat, c.lng) && c.from.as_deref().is_none_or(good_name) && seen.insert(c.place.as_str())) {
        let room = p.riot.len() < MAX_EACH;
        match p.riot.iter_mut().find(|x| x.place == c.place) {
            Some(x) => (x.from, x.last, x.n) = (c.from.clone().or_else(|| x.from.clone()), now_ms, x.n.saturating_add(1)),
            None if room => p.riot.push(RiotEntry { place: c.place.clone(), lat: c.lat, lng: c.lng, from: c.from.clone(), first: now_ms, last: now_ms, n: 1 }),
            None => continue,
        }
        changed = true;
    }
    changed
}

/// A personal best: the match that set it and its number, ms.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct BestMatch {
    pub path: String,
    pub ms: f64,
    pub id: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Bests {
    /// Each path's lowest in-game median, best first.
    pub by_path: Vec<BestMatch>,
    /// The lowest jitter of any match, `ms` being the jitter.
    pub steadiest: Option<BestMatch>,
    /// The longest run of matches in a row with no packet lost.
    pub clean_run: u32,
}

/// Personal bests over the match log, from full matches only. A match on an unknown or mixed path
/// measured no one path, so it sets no best for a path but still counts for the clean run.
pub fn bests(log: &[MatchPing]) -> Bests {
    let best = |m: &MatchPing, ms: f64| BestMatch { path: m.path.clone(), ms, id: m.id.clone() };
    let mut full: Vec<&MatchPing> = log.iter().filter(|m| m.duration_s >= BEST_MIN_S).collect();
    full.sort_by(|a, b| a.id.cmp(&b.id));
    let judged = || full.iter().copied().filter(|m| m.path != MIXED && m.path != "unknown");
    let mut by_path: Vec<BestMatch> = Vec::new();
    for m in judged() {
        match by_path.iter_mut().find(|b| b.path == m.path) {
            // Sorted by id, so an equal number leaves the first match that reached it.
            Some(b) if m.median_ms < b.ms => *b = best(m, m.median_ms),
            Some(_) => {}
            None => by_path.push(best(m, m.median_ms)),
        }
    }
    by_path.sort_by(|a, b| a.ms.total_cmp(&b.ms));
    let steadiest = judged().filter_map(|m| m.jitter_ms.map(|j| best(m, j))).reduce(|a, b| if b.ms < a.ms { b } else { a });
    let (mut run, mut clean_run) = (0, 0);
    for m in &full {
        run = if m.loss == 0.0 { run + 1 } else { 0 };
        clean_run = u32::max(clean_run, run);
    }
    Bests { by_path, steadiest, clean_run }
}

pub fn load(dir: &Path) -> Passport {
    std::fs::read_to_string(dir.join(FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Stamps one finished trace. The file is written beside the target and renamed over it, so a
/// crash never leaves half a passport.
pub fn add(dir: &Path, s: &Stamps, now_ms: u64) -> Result<(), String> {
    let _one = LOCK.lock().map_err(|e| e.to_string())?;
    let mut p = load(dir);
    if !stamp(&mut p, s, now_ms) {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_string(&p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(FILE)).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone, Debug)]
pub struct PassportView {
    #[serde(flatten)]
    pub passport: Passport,
    pub bests: Bests,
}

#[tauri::command]
pub async fn passport_read(app: tauri::AppHandle) -> Result<PassportView, String> {
    let dir = crate::app_dir(&app);
    crate::relay::blocking(move || Ok(PassportView { passport: load(&dir), bests: bests(&read_log(&dir)) })).await
}

#[tauri::command]
pub async fn passport_add(app: tauri::AppHandle, stamps: Stamps) -> Result<(), String> {
    let dir = crate::app_dir(&app);
    crate::relay::blocking(move || add(&dir, &stamps, crate::relay::now_ms())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(name: &str) -> PlaceIn {
        PlaceIn { place: name.into(), lat: 41.9, lng: -87.6 }
    }

    fn net(id: &str, name: &str) -> NetIn {
        NetIn { id: id.into(), name: name.into() }
    }

    #[test]
    fn a_stamp_counts_once_per_trace_and_keeps_its_first_time() {
        let mut p = Passport::default();
        let s = Stamps { cities: vec![place("Chicago, IL"), place("Chicago, IL")], networks: vec![net("AS1", "Comcast")], riot: vec![EntryIn { place: "Chicago, IL".into(), lat: 41.9, lng: -87.6, from: Some("Comcast".into()) }] };
        assert!(stamp(&mut p, &s, 100));
        assert_eq!(p.cities, [City { place: "Chicago, IL".into(), lat: 41.9, lng: -87.6, first: 100, last: 100, n: 1 }]);
        let again = Stamps { networks: vec![net("AS1", "Comcast Cable")], riot: vec![EntryIn { place: "Chicago, IL".into(), lat: 1.0, lng: 2.0, from: None }], ..Default::default() };
        assert!(stamp(&mut p, &again, 200));
        assert_eq!((p.cities[0].n, p.networks[0].n, p.networks[0].first, p.networks[0].last), (1, 2, 100, 200));
        assert_eq!(p.networks[0].name, "Comcast Cable", "the newest name for the same network");
        assert_eq!(p.riot, [RiotEntry { place: "Chicago, IL".into(), lat: 41.9, lng: -87.6, from: Some("Comcast".into()), first: 100, last: 200, n: 2 }], "an entry keeps its spot and its last known hand-off");
    }

    #[test]
    fn bad_stamps_change_nothing() {
        let mut p = Passport::default();
        let long = "x".repeat(MAX_NAME + 1);
        let s = Stamps {
            cities: vec![place(""), place(" "), place(&long), PlaceIn { place: "Nowhere".into(), lat: 91.0, lng: 0.0 }, PlaceIn { place: "Nan".into(), lat: f64::NAN, lng: 0.0 }],
            networks: vec![net("", "Comcast"), net("AS1", ""), net(&long, "Comcast")],
            riot: vec![EntryIn { place: "Chicago, IL".into(), lat: 41.9, lng: 200.0, from: None }, EntryIn { place: "Chicago, IL".into(), lat: 41.9, lng: -87.6, from: Some(long.clone()) }],
        };
        assert!(!stamp(&mut p, &s, 1));
        assert_eq!(p, Passport::default());
    }

    #[test]
    fn a_full_passport_keeps_what_it_has() {
        let mut p = Passport::default();
        for i in 0..MAX_EACH {
            p.cities.push(City { place: format!("c{i}"), lat: 0.0, lng: 0.0, first: 1, last: 1, n: 1 });
        }
        assert!(!stamp(&mut p, &Stamps { cities: vec![place("New")], ..Default::default() }, 2));
        assert_eq!(p.cities.len(), MAX_EACH);
        assert!(stamp(&mut p, &Stamps { cities: vec![place("c0")], ..Default::default() }, 2), "what is stamped still updates");
        assert_eq!(p.cities[0].n, 2);
    }

    #[test]
    fn stamps_survive_the_file_and_bad_files_read_as_empty() {
        let dir = std::env::temp_dir().join(format!("rig-passport-{}-{}", std::process::id(), crate::relay::now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir), Passport::default(), "no file yet");
        add(&dir, &Stamps { cities: vec![place("Chicago, IL")], ..Default::default() }, 5).unwrap();
        add(&dir, &Stamps { networks: vec![net("AS1", "Comcast")], ..Default::default() }, 6).unwrap();
        let p = load(&dir);
        assert_eq!((p.cities.len(), p.networks.len()), (1, 1));
        std::fs::write(dir.join(FILE), "not json").unwrap();
        assert_eq!(load(&dir), Passport::default());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn m(id: &str, path: &str, median: f64, jitter: Option<f64>, loss: f64, secs: f64) -> MatchPing {
        MatchPing { v: 1, id: id.into(), ts: 0, path: path.into(), samples: 60, min_ms: median - 1.0, median_ms: median, p95_ms: median + 2.0, jitter_ms: jitter, loss, duration_s: secs }
    }

    #[test]
    fn personal_bests_come_from_full_matches_on_a_known_path() {
        let log = [
            m("2026-11-05T20-00-00", "direct", 31.0, Some(4.0), 0.0, 1800.0),
            m("2026-11-06T20-00-00", "direct", 31.0, Some(5.0), 0.0, 1800.0),
            m("2026-11-07T20-00-00", "relay-chi-1", 28.5, Some(2.5), 0.002, 1800.0),
            m("2026-11-07T21-00-00", "direct", 20.0, Some(1.0), 0.0, 120.0),
            m("2026-11-07T22-00-00", "mixed", 19.0, Some(1.0), 0.0, 1800.0),
            m("2026-11-07T23-00-00", "unknown", 18.0, Some(1.0), 0.0, 1800.0),
        ];
        let b = bests(&log);
        assert_eq!(b.by_path, [BestMatch { path: "relay-chi-1".into(), ms: 28.5, id: "2026-11-07T20-00-00".into() }, BestMatch { path: "direct".into(), ms: 31.0, id: "2026-11-05T20-00-00".into() }], "the first match to reach an equal number, a remake doesn't count");
        assert_eq!(b.steadiest, Some(BestMatch { path: "relay-chi-1".into(), ms: 2.5, id: "2026-11-07T20-00-00".into() }));
        assert_eq!(b.clean_run, 2, "broken by the match that lost packets, then a mixed and an unknown match count");
        let order = [log[2].clone(), log[0].clone(), log[1].clone()];
        assert_eq!(bests(&order).clean_run, 2, "in match order, not read order");
        assert_eq!(bests(&[]), Bests { by_path: vec![], steadiest: None, clean_run: 0 });
    }
}
