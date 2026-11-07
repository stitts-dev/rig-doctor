//! Auto route selection: measure every candidate path (direct, and through each relay) to the
//! real game server, score each one on median latency, p95 jitter and loss, and pick a relay only
//! when it beats the direct route by `AUTO_MIN_GAIN_MS`. Ping boosters rank relays by the time to
//! the relay itself; this ranks paths by the time to the game server, which is what the game feels.
//!
//! Hosts are never pooled into one number for the decision: a relay can save 9 ms on three hosts
//! and cost 17 ms on a fourth, and an average hides both. When the live game server answered, its
//! measurement alone decides. Otherwise a relay must win by the bar on a majority of the hosts.
//!
//! A relay path can't be measured without its tunnel up, and the tunnel can't change mid-match, so
//! a full run happens before a game. Two things keep the admin prompts down: the direct time to the
//! relay's public endpoint is a floor under any route through it, so a relay that can't win is
//! dropped without raising the tunnel; and the run ends in the winner's state, so a run switches
//! the tunnel at most twice and often once.

use crate::relay::{self, TunnelState};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::path::Path;
use tauri::{AppHandle, Emitter};

/// Score saving a relay needs over the direct route before it is picked. Below this, run-to-run
/// noise and the relay's own risk (one more hop that can fail) outweigh the gain. The proof
/// verdict and the monthly refund rule use the same bar (proof::PROOF_MIN_GAIN_MS).
pub const AUTO_MIN_GAIN_MS: f64 = 10.0;
/// Each lost packet in a hundred costs this much score. League hides a lost update with the next
/// one at ~33 ms, so 1% loss reads as a few ms of extra delay on average.
pub const LOSS_MS_PER_PCT: f64 = 3.0;
/// Weight of p95 jitter in the score: spikes matter, but less than the steady median.
pub const JITTER_WEIGHT: f64 = 0.5;
/// Replies a path needs before it is scored.
pub const MIN_REPLIES: u32 = 5;
/// A path losing more than this is not picked whatever its latency.
pub const MAX_LOSS: f64 = 0.2;
/// Ping rounds per path in a full run. Each round pings every target once.
pub const DEFAULT_ROUNDS: u32 = 10;
/// A full run older than this is due again.
pub const RECHECK_AFTER_S: u64 = 600;
/// The current path is degraded when its median climbs this far over the run that picked it...
pub const DEGRADE_MS: f64 = 15.0;
/// ...or it loses this much.
pub const DEGRADE_LOSS: f64 = 0.05;

/// Riot NA addresses in Chicago that answer ping. Used until the live game server is known.
pub const RIOT_NA_PROBES: [&str; 4] = ["104.160.131.20", "104.160.131.1", "104.160.130.3", "104.160.130.10"];

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    Direct,
    Relay,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub kind: PathKind,
    pub label: String,
    /// The relay's WireGuard endpoint host. None for direct.
    pub endpoint: Option<String>,
}

pub fn direct() -> Candidate {
    Candidate { id: "direct".into(), kind: PathKind::Direct, label: "Direct".into(), endpoint: None }
}

/// Direct first, then one entry per saved relay, named as it was saved.
pub fn candidates(relays: &[relay::SavedRelay]) -> Vec<Candidate> {
    let mut out = vec![direct()];
    out.extend(relays.iter().map(|r| Candidate { id: r.id.clone(), kind: PathKind::Relay, label: r.id.clone(), endpoint: Some(r.cfg.endpoint_host.clone()) }));
    out
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct Score {
    pub sent: u32,
    pub received: u32,
    /// Fraction lost, 0 to 1.
    pub loss: f64,
    pub median: Option<f64>,
    /// 95th percentile of the change between consecutive replies to the same target.
    pub p95_jitter: Option<f64>,
    /// Lower is better: median + JITTER_WEIGHT * p95 jitter + LOSS_MS_PER_PCT per % lost.
    pub score: Option<f64>,
    /// Enough replies and little enough loss to be picked.
    pub eligible: bool,
}

/// Scores one path from its pings, one series per target. Jitter is taken within each target's
/// series, so two targets at different distances don't read as jitter.
pub fn score(series: &[Vec<Option<f64>>]) -> Score {
    let sent: u32 = series.iter().map(|s| s.len() as u32).sum();
    let mut got: Vec<f64> = series.iter().flatten().flatten().copied().collect();
    let received = got.len() as u32;
    let loss = if sent == 0 { 1.0 } else { 1.0 - received as f64 / sent as f64 };
    got.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = (!got.is_empty()).then(|| quantile(&got, 0.5));
    let mut diffs: Vec<f64> = series
        .iter()
        .flat_map(|s| {
            let r: Vec<f64> = s.iter().flatten().copied().collect();
            r.windows(2).map(|w| (w[1] - w[0]).abs()).collect::<Vec<_>>()
        })
        .collect();
    diffs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p95_jitter = (!diffs.is_empty()).then(|| quantile(&diffs, 0.95));
    let score = median.map(|m| m + JITTER_WEIGHT * p95_jitter.unwrap_or(0.0) + LOSS_MS_PER_PCT * loss * 100.0);
    Score { sent, received, loss, median, p95_jitter, score, eligible: received >= MIN_REPLIES && loss <= MAX_LOSS }
}

use crate::proof::quantile;

/// One target's score on one path.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HostScore {
    pub target: String,
    pub score: Score,
}

/// The pooled score of a path (shown and ranked) and one score per target (used to decide).
pub fn measure(targets: &[String], series: &[Vec<Option<f64>>]) -> (Score, Vec<HostScore>) {
    let hosts = targets.iter().zip(series).map(|(t, s)| HostScore { target: t.clone(), score: score(std::slice::from_ref(s)) }).collect();
    (score(series), hosts)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PathResult {
    pub candidate: Candidate,
    /// None when the path was not measured (see `note`).
    pub score: Option<Score>,
    /// The same pings split by target, in the run's target order. Empty when not measured.
    pub hosts: Vec<HostScore>,
    /// Fastest direct reply from the relay's endpoint: no route through the relay can beat it.
    pub floor_ms: Option<f64>,
    pub note: Option<String>,
}

/// Whether a relay whose endpoint answers in `floor_ms` at best can still beat `direct` by `gain`.
/// Every packet through the relay crosses the client-to-relay leg, so its score is at least that.
pub fn can_win(direct: &Score, floor_ms: Option<f64>, gain: f64) -> bool {
    match (direct.eligible, direct.score, floor_ms) {
        (true, Some(d), Some(f)) => f < d - gain,
        _ => true,
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Pick {
    pub id: String,
    /// What the pick saves over direct: on the live game server when it decided, else the saving a
    /// majority of hosts reaches (proof::majority_saving). None when direct is picked without a contest.
    pub gain_ms: Option<f64>,
    pub reason: String,
    /// The live game server, when its measurement alone decided.
    pub live: Option<String>,
    /// The relay direct was judged against: the pick, or the best relay when direct won.
    pub vs: Option<String>,
}

fn host<'a>(p: &'a PathResult, target: &str) -> Option<&'a Score> {
    p.hosts.iter().find(|h| h.target == target).map(|h| &h.score)
}

fn usable(s: Option<&Score>) -> Option<f64> {
    s.filter(|s| s.eligible).and_then(|s| s.score)
}

/// Picks the path to use. Direct wins unless an eligible relay beats it by `gain`:
/// on `live` (the game server) alone when that host answered on direct, otherwise on more than
/// half of the hosts direct answered well. A relay also wins when direct loses too much to be
/// usable while still answering.
pub fn choose(paths: &[PathResult], live: Option<&str>, gain: f64) -> Pick {
    let stay = |reason: String| Pick { id: "direct".into(), gain_ms: None, reason, live: None, vs: None };
    let Some(dp) = paths.iter().find(|p| p.candidate.kind == PathKind::Direct) else {
        return stay("The direct route was not measured.".into());
    };
    let Some(d) = dp.score.clone() else {
        return stay("The direct route was not measured.".into());
    };
    let relays: Vec<&PathResult> = paths.iter().filter(|p| p.candidate.kind == PathKind::Relay).filter(|p| p.score.as_ref().is_some_and(|s| s.eligible && s.score.is_some())).collect();
    if d.received == 0 {
        return stay("The server did not answer on the direct route, so there is nothing to compare. Staying direct.".into());
    }
    if relays.is_empty() {
        return stay(match paths.iter().find(|p| p.candidate.kind == PathKind::Relay) {
            // Why is in the relay's own row, so the pick doesn't repeat it.
            Some(p) => format!("{} was not measured. Staying direct.", p.candidate.label),
            None => "No relay to compare. Direct is the only path.".into(),
        });
    }

    // The live game server decides alone.
    if let Some(t) = live.filter(|t| host(dp, t).is_some_and(|s| s.received > 0)) {
        let dl = host(dp, t).unwrap();
        let best = relays.iter().filter_map(|p| usable(host(p, t)).map(|v| (*p, v))).min_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        let vs = best.map(|(r, _)| r.candidate.id.clone());
        let pick = |id: &str, gain_ms: Option<f64>, reason: String| Pick { id: id.into(), gain_ms, reason, live: Some(t.to_string()), vs: vs.clone() };
        let Some((r, rs)) = best else {
            return pick("direct", None, format!("No relay answered the game server {t} well enough. Staying direct."));
        };
        let Some(ds) = usable(Some(dl)) else {
            return pick(&r.candidate.id, dl.score.map(|ds| ds - rs), format!("Direct loses {:.0}% of packets to the game server {t}. {} is steadier.", dl.loss * 100.0, r.candidate.label));
        };
        let saved = ds - rs;
        let what = format!("On the game server {t}, {}", r.candidate.label);
        return if saved >= gain {
            pick(&r.candidate.id, Some(saved), format!("{what} scores {saved:.0} ms better than direct."))
        } else if saved > 0.0 {
            pick("direct", Some(saved), format!("{what} is only {saved:.0} ms better, under the {gain:.0} ms bar. Staying direct."))
        } else {
            pick("direct", Some(saved), format!("{what} is {:.0} ms worse. Staying direct.", -saved))
        };
    }

    if !d.eligible {
        let (r, rs) = relays.iter().map(|p| (*p, p.score.as_ref().unwrap().score.unwrap())).min_by(|a, b| a.1.partial_cmp(&b.1).unwrap()).unwrap();
        let ds = d.score.unwrap_or(f64::INFINITY);
        return Pick { id: r.candidate.id.clone(), gain_ms: ds.is_finite().then(|| ds - rs), reason: format!("Direct loses {:.0}% of packets. {} is steadier.", d.loss * 100.0, r.candidate.label), live: None, vs: Some(r.candidate.id.clone()) };
    }

    // No live server: count the hosts each relay wins by the bar. Never a pooled average.
    let judged: Vec<(&str, f64)> = dp.hosts.iter().filter_map(|h| usable(Some(&h.score)).map(|v| (h.target.as_str(), v))).collect();
    let n = judged.len();
    if n == 0 {
        return stay("No host answered well on the direct route. Staying direct.".into());
    }
    let tally = |r: &PathResult| {
        let saved: Vec<f64> = judged.iter().filter_map(|(t, ds)| usable(host(r, t)).map(|rs| ds - rs)).collect();
        (saved.iter().filter(|s| **s >= gain).count(), crate::proof::majority_saving(&saved))
    };
    let (r, (wins, saved)) = relays
        .iter()
        .map(|p| (*p, tally(p)))
        .max_by(|a, b| a.1 .0.cmp(&b.1 .0).then(a.1 .1.unwrap_or(f64::NEG_INFINITY).partial_cmp(&b.1 .1.unwrap_or(f64::NEG_INFINITY)).unwrap()))
        .unwrap();
    let of = format!("{wins} of {n} host{}", if n == 1 { "" } else { "s" });
    if wins * 2 > n {
        Pick { id: r.candidate.id.clone(), gain_ms: saved, reason: format!("{} is {gain:.0} ms or more better on {of}.", r.candidate.label), live: None, vs: Some(r.candidate.id.clone()) }
    } else {
        Pick { id: "direct".into(), gain_ms: saved, reason: format!("{} is {gain:.0} ms or more better on only {of}, not a majority{}. Staying direct.", r.candidate.label, match saved {
            Some(m) if m < 0.0 => format!(" (median {:.0} ms worse)", -m),
            Some(m) => format!(" (median {m:.0} ms better)"),
            None => String::new(),
        }), live: None, vs: Some(r.candidate.id.clone()) }
    }
}

/// Paths best first: eligible by score, then the rest in their original order.
pub fn rank(mut paths: Vec<PathResult>) -> Vec<PathResult> {
    let key = |p: &PathResult| p.score.as_ref().filter(|s| s.eligible).and_then(|s| s.score).unwrap_or(f64::INFINITY);
    paths.sort_by(|a, b| key(a).partial_cmp(&key(b)).unwrap());
    paths
}

/// Why the current path needs a full run again, or None. `age_s` is the time since the run that
/// picked it; `baseline_median` is the median that run measured for it.
pub fn recheck_reason(age_s: u64, baseline_median: Option<f64>, now: &Score) -> Option<String> {
    if now.received == 0 && now.sent > 0 {
        return Some("The game server stopped answering on this path.".into());
    }
    if now.loss >= DEGRADE_LOSS {
        return Some(format!("This path now loses {:.0}% of packets.", now.loss * 100.0));
    }
    if let (Some(b), Some(m)) = (baseline_median, now.median) {
        if m - b >= DEGRADE_MS {
            return Some(format!("This path is {:.0} ms slower than when it was picked.", m - b));
        }
    }
    (age_s >= RECHECK_AFTER_S).then(|| format!("Last full check was {} min ago.", age_s / 60))
}

// ---------- probing ----------

/// Pings every target `rounds` times, interleaved so a brief spike hits all targets alike.
fn probe(targets: &[String], rounds: u32, mut each: impl FnMut(u32)) -> Vec<Vec<Option<f64>>> {
    let mut series = vec![Vec::with_capacity(rounds as usize); targets.len()];
    let mut done = 0;
    for _ in 0..rounds {
        for (i, t) in targets.iter().enumerate() {
            series[i].push(relay::ping_once(t));
            done += 1;
            each(done);
        }
    }
    series
}

fn floor_of(host: &str, rounds: u32) -> Option<f64> {
    (0..rounds.min(5)).filter_map(|_| relay::ping_once(host)).min_by(|a, b| a.partial_cmp(b).unwrap())
}

#[derive(Serialize, Clone, Debug)]
pub struct AutoResult {
    pub targets: Vec<String>,
    /// The live game server among `targets`, when one was given and it answers ping.
    pub live: Option<String>,
    /// Best first.
    pub paths: Vec<PathResult>,
    pub pick: Pick,
    pub min_gain_ms: f64,
    /// Times this run switched the tunnel (each one can raise an admin prompt).
    pub switches: u32,
    /// The tunnel now matches the pick.
    pub applied: bool,
    pub started_at: u64,
    pub finished_at: u64,
    pub error: Option<String>,
    /// The proof record the backend judged and saved for this run. None without a relay to compare.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<crate::proof::JudgedRecord>,
    /// Why the record could not be saved, when it could not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AutoProgress {
    pub phase: String,
    pub done: u32,
    pub total: u32,
}

/// Targets to probe: the ones given that parse as IPs (the live game server first), then Riot NA's
/// ping addresses, without repeats. Game servers often drop ping, so the Riot addresses stay in.
pub fn pick_targets(given: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let given = given.iter().filter_map(|t| t.trim().parse::<IpAddr>().ok()).map(|ip| ip.to_string());
    for t in given.chain(RIOT_NA_PROBES.iter().map(|s| s.to_string())) {
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// Keeps the targets that answer at least one of two pings, so a server that drops ping doesn't
/// count as loss on every path. All silent keeps them all: then the run reports no replies.
fn responsive(targets: Vec<String>) -> Vec<String> {
    let ok: Vec<String> = targets.iter().filter(|t| (0..2).any(|_| relay::ping_once(t).is_some())).cloned().collect();
    if ok.is_empty() {
        targets
    } else {
        ok
    }
}

/// Moves the tunnel to `target` (None is direct) and tracks where it is in `on`. Returns the
/// number of tunnel changes, each of which can raise an admin prompt.
fn switch_to(dir: &Path, target: Option<&str>, on: &mut Option<String>) -> Result<u32, String> {
    if on.as_deref() == target {
        return Ok(0);
    }
    let mut n = 0;
    if on.is_some() {
        relay::set_tunnel(dir, false)?;
        *on = None;
        n += 1;
    }
    if let Some(id) = target {
        relay::activate(dir, id)?;
        relay::set_tunnel(dir, true)?;
        *on = Some(id.to_string());
        n += 1;
    }
    Ok(n)
}

/// A full run. Measures the path the tunnel is on now, then direct, then each relay that might
/// beat direct (its endpoint alone must leave room), and leaves the tunnel on the winner when
/// `apply`. Without `apply` the tunnel goes back to where it was.
pub fn auto_blocking(dir: &Path, targets: &[String], rounds: u32, apply: bool, progress: impl Fn(AutoProgress)) -> Result<AutoResult, String> {
    let started_at = relay::now_ms();
    let relays = relay::list(dir)?;
    let first_active = relay::active_id(dir, &relays)?;
    let cands = candidates(&relays);
    let live_given: Option<String> = targets.iter().find_map(|t| t.trim().parse::<IpAddr>().ok()).map(|ip| ip.to_string());
    let mut targets = pick_targets(targets);
    if !relays.is_empty() {
        // A target a tunnel doesn't carry would measure the direct route twice.
        let carried: Vec<String> = targets.iter().filter(|t| t.parse().map(|ip| relays.iter().all(|r| relay::routes_via_tunnel(&r.cfg, &ip))).unwrap_or(false)).cloned().collect();
        if carried.is_empty() {
            return Err("None of the probe targets are in every relay's AllowedIPs, so the relay routes can't be measured.".into());
        }
        targets = carried;
    }
    let targets = responsive(targets);
    let rounds = rounds.clamp(3, 50);
    let total = rounds * targets.len() as u32;
    let live = live_given.filter(|t| targets.contains(t));
    let run = |phase: &str| measure(&targets, &probe(&targets, rounds, |done| progress(AutoProgress { phase: phase.into(), done, total })));

    let now = if relays.is_empty() { TunnelState::Down } else { relay::tunnel_state(dir) };
    if !matches!(now, TunnelState::Up | TunnelState::Down) {
        return Err("The tunnel is changing or partly up. Press Off, then run Auto again.".into());
    }
    let was_up = now == TunnelState::Up;
    if was_up && first_active.is_none() {
        return Err("The tunnel is on but its relay isn't saved. Import its config again, then run Auto.".into());
    }
    let mut results: Vec<PathResult> = cands.iter().map(|c| PathResult { candidate: c.clone(), score: None, hosts: Vec::new(), floor_ms: None, note: None }).collect();
    let idx = |id: &str| cands.iter().position(|c| c.id == id).unwrap_or(0);
    let (mut switches, mut errors) = (0u32, Vec::new());
    let mut on: Option<String> = if was_up { first_active.clone() } else { None };
    let tools_ok = relays.is_empty() || relay::installed(&relay::find_tools());

    // The path in use first, then direct, so every relay is judged against direct.
    let mut set = |i: usize, (sc, hosts): (Score, Vec<HostScore>)| {
        results[i].score = Some(sc);
        results[i].hosts = hosts;
    };
    match on.clone() {
        Some(id) => set(idx(&id), run(&id)),
        None => set(0, run("direct")),
    }
    let mut stuck = false;
    if on.is_some() {
        match relay::guard_game().and_then(|_| switch_to(dir, None, &mut on)) {
            Ok(n) => {
                switches += n;
                let m = run("direct");
                results[0].score = Some(m.0);
                results[0].hosts = m.1;
            }
            Err(e) => {
                // The reason sits on the path it stopped; `error` is for failures no path shows.
                results[0].note = Some(format!("Not measured: {e}"));
                stuck = true;
            }
        }
    }

    let direct_score = results[0].score.clone();
    for r in &relays {
        let i = idx(&r.id);
        if results[i].score.is_some() {
            continue;
        }
        if stuck {
            results[i].note = Some("Not measured: the tunnel could not be switched.".into());
            continue;
        }
        let floor = if on.is_none() { floor_of(&r.cfg.endpoint_host, rounds) } else { None };
        results[i].floor_ms = floor;
        let worth = direct_score.as_ref().map(|d| can_win(d, floor, AUTO_MIN_GAIN_MS)).unwrap_or(true);
        if !worth {
            results[i].note = Some(format!("{} can't win: its endpoint alone answers in {:.0} ms. Not switched.", r.id, floor.unwrap_or(0.0)));
            continue;
        }
        if !tools_ok {
            results[i].note = Some(relay::missing_message().into());
            continue;
        }
        match relay::guard_game().and_then(|_| switch_to(dir, Some(&r.id), &mut on)) {
            Ok(n) => {
                switches += n;
                if let Some(p) = relay::probe_addr(&r.cfg) {
                    let _ = (0..5).find_map(|_| relay::ping_once(&p.to_string()));
                }
                let m = run(&r.id);
                results[i].score = Some(m.0);
                results[i].hosts = m.1;
            }
            Err(e) => {
                results[i].note = Some(format!("Not measured: {e}"));
                stuck = true;
            }
        }
    }

    let pick = choose(&results, live.as_deref(), AUTO_MIN_GAIN_MS);
    let want: Option<String> = (pick.id != "direct").then(|| pick.id.clone());
    let target = if apply { want.clone() } else if was_up { first_active.clone() } else { None };
    if !relays.is_empty() && on != target {
        match switch_to(dir, target.as_deref(), &mut on) {
            Ok(n) => switches += n,
            Err(e) => errors.push(format!("Could not move the tunnel to {}: {e}", target.as_deref().unwrap_or("direct"))),
        }
    }
    // Ending on direct, the relay Manual turns on is the one it was before the run.
    if on.is_none() {
        if let Some(a) = first_active.as_deref() {
            if let Err(e) = relay::activate(dir, a) {
                errors.push(format!("Could not restore {a} as the relay: {e}"));
            }
        }
    }
    Ok(AutoResult {
        targets,
        live,
        paths: rank(results),
        applied: on == want,
        pick,
        min_gain_ms: AUTO_MIN_GAIN_MS,
        switches,
        started_at,
        finished_at: relay::now_ms(),
        error: (!errors.is_empty()).then(|| errors.join(" ")),
        record: None,
        log_error: None,
    })
}

#[derive(Serialize, Clone, Debug)]
pub struct CheckResult {
    pub path: String,
    pub score: Score,
    pub recheck: Option<String>,
}

/// A light check of the path the tunnel is on now: a few pings, no switching, safe mid-match.
pub fn check_blocking(dir: &Path, targets: &[String], rounds: u32, age_s: u64, baseline_median: Option<f64>) -> CheckResult {
    let targets = responsive(pick_targets(targets));
    let s = score(&probe(&targets, rounds.clamp(1, 20), |_| {}));
    let up = relay::load(dir).ok().flatten().is_some() && relay::tunnel_state(dir) == TunnelState::Up;
    let active = relay::list(dir).and_then(|l| relay::active_id(dir, &l)).ok().flatten();
    let path = match (up, active) {
        (true, Some(id)) => id,
        (true, None) => "relay".into(),
        _ => "direct".into(),
    };
    CheckResult { path, recheck: recheck_reason(age_s, baseline_median, &s), score: s }
}

/// Judges a finished run and appends it to the proof log, when it had a relay to compare.
pub fn log_run(dir: &Path, a: &mut AutoResult) {
    if let Some(rec) = crate::proof::from_auto(a) {
        let (record, log_error) = crate::proof::save(dir, rec);
        a.record = Some(record);
        a.log_error = log_error;
    }
}

#[tauri::command]
pub async fn route_auto(app: AppHandle, targets: Option<Vec<String>>, rounds: Option<u32>, apply: Option<bool>) -> Result<AutoResult, String> {
    let dir = crate::app_dir(&app);
    relay::blocking(move || {
        let _g = relay::busy()?;
        let mut a = auto_blocking(&dir, &targets.unwrap_or_default(), rounds.unwrap_or(DEFAULT_ROUNDS), apply.unwrap_or(true), |p| {
            let _ = app.emit("auto:progress", p);
        })?;
        log_run(&dir, &mut a);
        Ok(a)
    })
    .await
}

#[tauri::command]
pub async fn route_check(app: AppHandle, targets: Option<Vec<String>>, age_s: u64, baseline_median: Option<f64>) -> Result<CheckResult, String> {
    let dir = crate::app_dir(&app);
    relay::blocking(move || Ok(check_blocking(&dir, &targets.unwrap_or_default(), 5, age_s, baseline_median))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[f64]) -> Vec<Option<f64>> {
        v.iter().map(|x| Some(*x)).collect()
    }
    /// A path measured on one host.
    fn path(id: &str, kind: PathKind, sc: Option<Score>) -> PathResult {
        let hosts = sc.iter().map(|s| HostScore { target: "192.0.2.1".into(), score: s.clone() }).collect();
        PathResult { candidate: Candidate { id: id.into(), kind, label: if kind == PathKind::Direct { "Direct".into() } else { "Relay 1".into() }, endpoint: None }, score: sc, hosts, floor_ms: None, note: None }
    }
    /// A path measured on several hosts, ten steady replies each, scored as a real run would be.
    fn multi(id: &str, kind: PathKind, label: &str, medians: &[f64]) -> PathResult {
        let targets: Vec<String> = RIOT_NA_PROBES.iter().map(|t| t.to_string()).collect();
        let series: Vec<Vec<Option<f64>>> = medians.iter().map(|m| s(&[*m; 10])).collect();
        let (sc, hosts) = measure(&targets[..medians.len()], &series);
        PathResult { candidate: Candidate { id: id.into(), kind, label: label.into(), endpoint: None }, score: Some(sc), hosts, floor_ms: None, note: None }
    }
    /// The first live Auto run on the Windows PC, 2026-11-07, medians in ms per Riot NA probe, in
    /// RIOT_NA_PROBES order: direct, Chicago relay, New Jersey relay.
    fn toaster() -> [PathResult; 3] {
        [
            multi("direct", PathKind::Direct, "Direct", &[25.0, 79.0, 76.0, 76.0]),
            multi("relay-chi-1", PathKind::Relay, "relay-chi-1", &[42.0, 68.0, 68.0, 67.0]),
            multi("relay-ewr-1", PathKind::Relay, "relay-ewr-1", &[31.0, 80.0, 80.0, 80.0]),
        ]
    }
    fn flat(median: f64, n: usize) -> Score {
        score(&[s(&vec![median; n])])
    }

    #[test]
    fn score_is_median_plus_jitter_and_loss() {
        // Replies 30, 32, 30, 32 ... with one of ten lost.
        let mut v: Vec<Option<f64>> = (0..10).map(|i| Some(if i % 2 == 0 { 30.0 } else { 32.0 })).collect();
        v[9] = None;
        let sc = score(&[v]);
        assert_eq!((sc.sent, sc.received), (10, 9));
        assert!((sc.loss - 0.1).abs() < 1e-9);
        assert_eq!(sc.median, Some(30.0));
        assert_eq!(sc.p95_jitter, Some(2.0));
        // 30 + 0.5 * 2 + 3 * 10
        assert!((sc.score.unwrap() - 61.0).abs() < 1e-9);
        assert!(sc.eligible);
    }

    #[test]
    fn jitter_is_within_each_target() {
        // Two steady targets 20 ms apart: no jitter, though the pooled replies jump.
        let sc = score(&[s(&[20.0; 5]), s(&[40.0; 5])]);
        assert_eq!(sc.p95_jitter, Some(0.0));
        assert_eq!(sc.median, Some(30.0));
    }

    #[test]
    fn too_few_replies_or_too_much_loss_is_ineligible() {
        assert!(!score(&[s(&[30.0; 4])]).eligible);
        let mut v = s(&[30.0; 10]);
        for x in v.iter_mut().take(3) {
            *x = None;
        }
        let sc = score(&[v]);
        assert!(!sc.eligible, "30% loss");
        let empty = score(&[vec![None; 10]]);
        assert_eq!((empty.median, empty.score, empty.loss), (None, None, 1.0));
    }

    #[test]
    fn relay_needs_the_full_threshold() {
        let d = path("direct", PathKind::Direct, Some(flat(45.0, 20)));
        let r9 = path("relay-1", PathKind::Relay, Some(flat(36.0, 20)));
        let p = choose(&[d.clone(), r9], None, AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "direct");
        assert_eq!(p.gain_ms, Some(9.0));
        let r10 = path("relay-1", PathKind::Relay, Some(flat(35.0, 20)));
        let p = choose(&[d, r10], None, AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "relay-1");
        assert_eq!(p.gain_ms, Some(10.0));
    }

    #[test]
    fn slower_relay_stays_direct() {
        let p = choose(&[path("direct", PathKind::Direct, Some(flat(30.0, 20))), path("relay-1", PathKind::Relay, Some(flat(48.0, 20)))], None, AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "direct");
        assert!(p.reason.contains("median 18 ms worse"), "{}", p.reason);
    }

    #[test]
    fn lossy_direct_loses_to_a_clean_relay() {
        let mut v = s(&[30.0; 10]);
        for x in v.iter_mut().take(4) {
            *x = None;
        }
        let p = choose(&[path("direct", PathKind::Direct, Some(score(&[v]))), path("relay-1", PathKind::Relay, Some(flat(33.0, 10)))], None, AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "relay-1");
    }

    #[test]
    fn silent_server_or_no_relay_stays_direct() {
        let silent = score(&[vec![None; 10]]);
        let p = choose(&[path("direct", PathKind::Direct, Some(silent)), path("relay-1", PathKind::Relay, Some(flat(20.0, 10)))], None, AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "direct");
        let p = choose(&[path("direct", PathKind::Direct, Some(flat(30.0, 10)))], None, AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "direct");
        let unmeasured = choose(&[path("direct", PathKind::Direct, Some(flat(30.0, 10))), path("relay-1", PathKind::Relay, None)], None, AUTO_MIN_GAIN_MS);
        assert_eq!(unmeasured.id, "direct");
        // The relay row carries why it wasn't measured; the pick says so once, without repeating it.
        let mut blocked = path("relay-1", PathKind::Relay, None);
        blocked.note = Some("Not measured: League of Legends is in a game.".into());
        let p = choose(&[path("direct", PathKind::Direct, Some(flat(30.0, 10))), blocked], None, AUTO_MIN_GAIN_MS);
        assert_eq!(p.reason, "Relay 1 was not measured. Staying direct.");
    }

    #[test]
    fn best_of_several_relays_wins() {
        let paths = [
            path("direct", PathKind::Direct, Some(flat(60.0, 10))),
            path("relay-1", PathKind::Relay, Some(flat(40.0, 10))),
            path("relay-2", PathKind::Relay, Some(flat(32.0, 10))),
        ];
        assert_eq!(choose(&paths, None, AUTO_MIN_GAIN_MS).id, "relay-2");
        let ranked = rank(paths.to_vec());
        assert_eq!(ranked.iter().map(|p| p.candidate.id.as_str()).collect::<Vec<_>>(), ["relay-2", "relay-1", "direct"]);
    }

    #[test]
    fn toaster_run_without_a_game_stays_direct() {
        // Chicago is 10+ ms better on one of four hosts (11 ms on .131.1; 8 and 9 on two more, 17
        // worse on .131.20). One of four is no majority.
        let p = choose(&toaster(), None, AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "direct");
        assert_eq!(p.live, None);
        assert!(p.reason.contains("relay-chi-1") && p.reason.contains("only 1 of 4 hosts"), "{}", p.reason);
        // Chicago's per-host savings -17, 11, 8, 9: three of four reach 8 ms.
        assert_eq!(p.gain_ms, Some(8.0));
    }

    #[test]
    fn toaster_game_on_131_1_picks_chicago() {
        let live = RIOT_NA_PROBES[1];
        assert!(live.ends_with(".131.1"));
        let p = choose(&toaster(), Some(live), AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "relay-chi-1");
        assert_eq!(p.gain_ms, Some(11.0));
        assert_eq!(p.live.as_deref(), Some(live));
        assert!(p.reason.contains("11 ms better"), "{}", p.reason);
    }

    #[test]
    fn toaster_game_on_131_20_stays_direct() {
        let live = RIOT_NA_PROBES[0];
        assert!(live.ends_with(".131.20"));
        let p = choose(&toaster(), Some(live), AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "direct");
        // New Jersey is the best relay there at 31 ms, still 6 ms worse than direct.
        assert_eq!(p.gain_ms, Some(-6.0));
        assert!(p.reason.contains("relay-ewr-1") && p.reason.contains("6 ms worse"), "{}", p.reason);
    }

    #[test]
    fn toaster_pooled_score_would_hide_both() {
        // The pooled medians the old rule compared: under 10 ms apart, so it said direct for any game.
        let [d, chi, _] = toaster();
        let saved = d.score.unwrap().score.unwrap() - chi.score.unwrap().score.unwrap();
        assert!(saved < AUTO_MIN_GAIN_MS, "{saved}");
    }

    #[test]
    fn majority_of_hosts_picks_the_relay() {
        let paths = [multi("direct", PathKind::Direct, "Direct", &[25.0, 79.0, 76.0, 76.0]), multi("relay-1", PathKind::Relay, "relay-1", &[42.0, 68.0, 64.0, 65.0])];
        let p = choose(&paths, None, AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "relay-1", "{}", p.reason);
        assert!(p.reason.contains("3 of 4 hosts"), "{}", p.reason);
        // Two of four is a tie, not a majority.
        let paths = [multi("direct", PathKind::Direct, "Direct", &[25.0, 79.0, 76.0, 76.0]), multi("relay-1", PathKind::Relay, "relay-1", &[42.0, 68.0, 64.0, 70.0])];
        assert_eq!(choose(&paths, None, AUTO_MIN_GAIN_MS).id, "direct");
    }

    #[test]
    fn live_server_lossy_on_direct_picks_a_clean_relay() {
        let mut paths = toaster();
        let mut v = s(&[25.0; 10]);
        for x in v.iter_mut().take(4) {
            *x = None;
        }
        paths[0].hosts[0].score = score(&[v]);
        let p = choose(&paths, Some(RIOT_NA_PROBES[0]), AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "relay-ewr-1", "{}", p.reason);
    }

    #[test]
    fn live_server_not_measured_falls_back_to_hosts() {
        let p = choose(&toaster(), Some("192.0.2.9"), AUTO_MIN_GAIN_MS);
        assert_eq!((p.id.as_str(), p.live.as_deref()), ("direct", None));
    }

    fn run_of(paths: [PathResult; 3], live: Option<&str>) -> AutoResult {
        let pick = choose(&paths, live, AUTO_MIN_GAIN_MS);
        let targets = paths[0].hosts.iter().map(|h| h.target.clone()).collect();
        AutoResult { targets, live: live.map(String::from), paths: rank(paths.to_vec()), pick, min_gain_ms: AUTO_MIN_GAIN_MS, switches: 0, applied: true, started_at: 0, finished_at: 1, error: None, record: None, log_error: None }
    }

    #[test]
    fn proof_verdict_matches_the_pick() {
        use crate::proof::{from_auto, VerdictKind};
        let wins = || {
            let mut p = toaster();
            p[1] = multi("relay-chi-1", PathKind::Relay, "relay-chi-1", &[42.0, 66.0, 64.0, 65.0]);
            p
        };
        let cases: [(&str, [PathResult; 3], Option<&str>, &str, VerdictKind); 4] = [
            ("toaster, no game", toaster(), None, "direct", VerdictKind::None),
            ("toaster, game on .131.1", toaster(), Some(RIOT_NA_PROBES[1]), "relay-chi-1", VerdictKind::Gain),
            ("toaster, game on .131.20", toaster(), Some(RIOT_NA_PROBES[0]), "direct", VerdictKind::None),
            ("relay wins 3 of 4, loses 17 on one", wins(), None, "relay-chi-1", VerdictKind::Gain),
        ];
        for (name, paths, live, id, kind) in cases {
            let a = run_of(paths, live);
            assert_eq!(a.pick.id, id, "{name}: {}", a.pick.reason);
            let rec = from_auto(&a).unwrap();
            let v = rec.judge();
            assert_eq!(v.kind, kind, "{name}: {}", v.text);
            assert_eq!(rec.verdict, kind, "{name}: stored verdict");
            assert_eq!(rec.hosts.is_some(), live.is_none(), "{name}: per-host numbers only without a game server");
            assert_eq!(v.saved_ms.map(|x| x.round()), a.pick.gain_ms.map(|x| x.round()), "{name}: same saving");
            // The record read back from the log is judged the same.
            let back: crate::proof::ProofRecord = serde_json::from_str(&serde_json::to_string(&rec).unwrap()).unwrap();
            assert_eq!(back.judge(), v, "{name}: round trip");
        }
    }

    #[test]
    fn endpoint_floor_prunes_relays_that_cannot_win() {
        let d = flat(40.0, 10);
        assert!(!can_win(&d, Some(31.0), AUTO_MIN_GAIN_MS), "31 + anything >= 40 - 10");
        assert!(can_win(&d, Some(25.0), AUTO_MIN_GAIN_MS));
        assert!(can_win(&d, None, AUTO_MIN_GAIN_MS), "endpoint that drops ping proves nothing");
        assert!(can_win(&score(&[vec![None; 10]]), Some(5.0), AUTO_MIN_GAIN_MS));
    }

    #[test]
    fn recheck_on_timer_and_degradation() {
        let ok = flat(31.0, 5);
        assert_eq!(recheck_reason(60, Some(30.0), &ok), None);
        assert!(recheck_reason(RECHECK_AFTER_S, Some(30.0), &ok).unwrap().contains("10 min"));
        assert!(recheck_reason(60, Some(30.0), &flat(46.0, 5)).unwrap().contains("16 ms slower"));
        let mut v = s(&[30.0; 20]);
        v[0] = None;
        assert!(recheck_reason(60, Some(30.0), &score(&[v])).unwrap().contains("5%"));
        assert!(recheck_reason(60, Some(30.0), &score(&[vec![None; 5]])).unwrap().contains("stopped answering"));
    }

    #[test]
    fn targets_default_to_riot_and_drop_junk() {
        assert_eq!(pick_targets(&[]).len(), RIOT_NA_PROBES.len());
        let t = pick_targets(&["nope".into(), " 192.0.2.7 ".into(), RIOT_NA_PROBES[1].into()]);
        assert_eq!(t[0], "192.0.2.7");
        assert_eq!(t.len(), 1 + RIOT_NA_PROBES.len(), "junk dropped, no repeats");
    }

    #[test]
    fn candidates_list_direct_then_relays() {
        assert_eq!(candidates(&[]), vec![direct()]);
        let cfg = relay::parse_config("[Interface]
PrivateKey = cGxhY2Vob2xkZXIta2V5LW5vdC1yZWFsLTAwMDAwMDA=
Address = 10.66.66.2/32
[Peer]
PublicKey = cGxhY2Vob2xkZXItcGVlci1ub3QtcmVhbC0xMTExMTE=
Endpoint = 203.0.113.10:51820
AllowedIPs = 10.66.66.1/32, 198.51.100.0/24
").unwrap();
        let relays = vec![relay::SavedRelay { id: "relay-chi-1".into(), cfg: cfg.clone() }, relay::SavedRelay { id: "relay-ewr-1".into(), cfg }];
        let c = candidates(&relays);
        assert_eq!(c.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["direct", "relay-chi-1", "relay-ewr-1"]);
        assert!(c[1..].iter().all(|c| c.kind == PathKind::Relay && c.endpoint.as_deref() == Some("203.0.113.10")));
    }
}
