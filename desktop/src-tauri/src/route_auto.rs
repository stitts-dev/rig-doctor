//! Auto route selection: measure every candidate path (direct, and through each relay) to the
//! real game server, score each one on median latency, p95 jitter and loss, and pick a relay only
//! when it beats the direct route by `AUTO_MIN_GAIN_MS`. Ping boosters rank relays by the time to
//! the relay itself; this ranks paths by the time to the game server, which is what the game feels.
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
/// noise and the relay's own risk (one more hop that can fail) outweigh the gain.
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

/// Linear interpolation between ranks, matching the Proof panel's quantile.
fn quantile(sorted: &[f64], q: f64) -> f64 {
    let i = (sorted.len() - 1) as f64 * q;
    let lo = i.floor() as usize;
    let hi = (lo + 1).min(sorted.len() - 1);
    sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo as f64)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PathResult {
    pub candidate: Candidate,
    /// None when the path was not measured (see `note`).
    pub score: Option<Score>,
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
    /// Direct score minus the picked relay's score. None when direct is picked without a contest.
    pub gain_ms: Option<f64>,
    pub reason: String,
}

/// Picks the path to use. Direct wins unless a relay is eligible and either saves at least `gain`
/// score, or direct itself loses too much to be usable while still answering.
pub fn choose(paths: &[PathResult], gain: f64) -> Pick {
    let stay = |reason: String| Pick { id: "direct".into(), gain_ms: None, reason };
    let Some(d) = paths.iter().find(|p| p.candidate.kind == PathKind::Direct).and_then(|p| p.score.clone()) else {
        return stay("The direct route was not measured.".into());
    };
    let best = paths
        .iter()
        .filter(|p| p.candidate.kind == PathKind::Relay)
        .filter_map(|p| p.score.as_ref().filter(|s| s.eligible).and_then(|s| s.score).map(|v| (p, v)))
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    if d.received == 0 {
        return stay("The server did not answer on the direct route, so there is nothing to compare. Staying direct.".into());
    }
    let Some((r, rs)) = best else {
        return stay(match paths.iter().find(|p| p.candidate.kind == PathKind::Relay) {
            Some(p) => p.note.clone().unwrap_or_else(|| format!("{} could not be measured. Staying direct.", p.candidate.label)),
            None => "No relay to compare. Direct is the only path.".into(),
        });
    };
    let ds = d.score.unwrap_or(f64::INFINITY);
    if !d.eligible {
        return Pick { id: r.candidate.id.clone(), gain_ms: ds.is_finite().then(|| ds - rs), reason: format!("Direct loses {:.0}% of packets. {} is steadier.", d.loss * 100.0, r.candidate.label) };
    }
    let saved = ds - rs;
    if saved >= gain {
        Pick { id: r.candidate.id.clone(), gain_ms: Some(saved), reason: format!("{} scores {saved:.0} ms better than direct.", r.candidate.label) }
    } else if saved > 0.0 {
        Pick { id: "direct".into(), gain_ms: Some(saved), reason: format!("{} is only {saved:.0} ms better, under the {gain:.0} ms bar. Staying direct.", r.candidate.label) }
    } else {
        Pick { id: "direct".into(), gain_ms: Some(saved), reason: format!("{} is {:.0} ms worse. Staying direct.", r.candidate.label, -saved) }
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
    let run = |phase: &str| score(&probe(&targets, rounds, |done| progress(AutoProgress { phase: phase.into(), done, total })));

    let now = if relays.is_empty() { TunnelState::Down } else { relay::tunnel_state(dir) };
    if !matches!(now, TunnelState::Up | TunnelState::Down) {
        return Err("The tunnel is changing or partly up. Press Off, then run Auto again.".into());
    }
    let was_up = now == TunnelState::Up;
    if was_up && first_active.is_none() {
        return Err("The tunnel is on but its relay isn't saved. Import its config again, then run Auto.".into());
    }
    let mut results: Vec<PathResult> = cands.iter().map(|c| PathResult { candidate: c.clone(), score: None, floor_ms: None, note: None }).collect();
    let idx = |id: &str| cands.iter().position(|c| c.id == id).unwrap_or(0);
    let (mut switches, mut errors) = (0u32, Vec::new());
    let mut on: Option<String> = if was_up { first_active.clone() } else { None };
    let tools_ok = relays.is_empty() || relay::installed(&relay::find_tools());

    // The path in use first, then direct, so every relay is judged against direct.
    match on.clone() {
        Some(id) => results[idx(&id)].score = Some(run(&id)),
        None => results[0].score = Some(run("direct")),
    }
    let mut stuck = false;
    if on.is_some() {
        match relay::guard_game().and_then(|_| switch_to(dir, None, &mut on)) {
            Ok(n) => {
                switches += n;
                results[0].score = Some(run("direct"));
            }
            Err(e) => {
                results[0].note = Some(format!("Not measured: {e}"));
                errors.push(e);
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
                results[i].score = Some(run(&r.id));
            }
            Err(e) => {
                results[i].note = Some(format!("Not measured: {e}"));
                errors.push(e);
                stuck = true;
            }
        }
    }

    let pick = choose(&results, AUTO_MIN_GAIN_MS);
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
        paths: rank(results),
        applied: on == want,
        pick,
        min_gain_ms: AUTO_MIN_GAIN_MS,
        switches,
        started_at,
        finished_at: relay::now_ms(),
        error: (!errors.is_empty()).then(|| errors.join(" ")),
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

#[tauri::command]
pub async fn route_auto(app: AppHandle, targets: Option<Vec<String>>, rounds: Option<u32>, apply: Option<bool>) -> Result<AutoResult, String> {
    let dir = crate::app_dir(&app);
    relay::blocking(move || {
        let _g = relay::busy()?;
        auto_blocking(&dir, &targets.unwrap_or_default(), rounds.unwrap_or(DEFAULT_ROUNDS), apply.unwrap_or(true), |p| {
            let _ = app.emit("auto:progress", p);
        })
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
    fn path(id: &str, kind: PathKind, sc: Option<Score>) -> PathResult {
        PathResult { candidate: Candidate { id: id.into(), kind, label: if kind == PathKind::Direct { "Direct".into() } else { "Relay 1".into() }, endpoint: None }, score: sc, floor_ms: None, note: None }
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
        let p = choose(&[d.clone(), r9], AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "direct");
        assert_eq!(p.gain_ms, Some(9.0));
        let r10 = path("relay-1", PathKind::Relay, Some(flat(35.0, 20)));
        let p = choose(&[d, r10], AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "relay-1");
        assert_eq!(p.gain_ms, Some(10.0));
    }

    #[test]
    fn slower_relay_stays_direct() {
        let p = choose(&[path("direct", PathKind::Direct, Some(flat(30.0, 20))), path("relay-1", PathKind::Relay, Some(flat(48.0, 20)))], AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "direct");
        assert!(p.reason.contains("18 ms worse"), "{}", p.reason);
    }

    #[test]
    fn lossy_direct_loses_to_a_clean_relay() {
        let mut v = s(&[30.0; 10]);
        for x in v.iter_mut().take(4) {
            *x = None;
        }
        let p = choose(&[path("direct", PathKind::Direct, Some(score(&[v]))), path("relay-1", PathKind::Relay, Some(flat(33.0, 10)))], AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "relay-1");
    }

    #[test]
    fn silent_server_or_no_relay_stays_direct() {
        let silent = score(&[vec![None; 10]]);
        let p = choose(&[path("direct", PathKind::Direct, Some(silent)), path("relay-1", PathKind::Relay, Some(flat(20.0, 10)))], AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "direct");
        let p = choose(&[path("direct", PathKind::Direct, Some(flat(30.0, 10)))], AUTO_MIN_GAIN_MS);
        assert_eq!(p.id, "direct");
        let unmeasured = choose(&[path("direct", PathKind::Direct, Some(flat(30.0, 10))), path("relay-1", PathKind::Relay, None)], AUTO_MIN_GAIN_MS);
        assert_eq!(unmeasured.id, "direct");
    }

    #[test]
    fn best_of_several_relays_wins() {
        let paths = [
            path("direct", PathKind::Direct, Some(flat(60.0, 10))),
            path("relay-1", PathKind::Relay, Some(flat(40.0, 10))),
            path("relay-2", PathKind::Relay, Some(flat(32.0, 10))),
        ];
        assert_eq!(choose(&paths, AUTO_MIN_GAIN_MS).id, "relay-2");
        let ranked = rank(paths.to_vec());
        assert_eq!(ranked.iter().map(|p| p.candidate.id.as_str()).collect::<Vec<_>>(), ["relay-2", "relay-1", "direct"]);
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
