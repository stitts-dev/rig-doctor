//! Relay proof: the record of every direct-vs-relay measurement, the verdict on it, and the monthly
//! refund rule. The backend measures, judges and appends each record itself, so the log holds only
//! what this code measured, and every screen and the refund rule read one set of numbers and one rule.

use crate::relay::{RelayComparison, RouteMeasure};
use crate::route_auto::{AutoResult, MatchCount, PathKind, Score, AUTO_MIN_GAIN_MS, MIN_MATCHES};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Smallest median saving that counts as a gain, for one run and for a month. It is the bar Auto
/// picks a relay by, so a relay Auto would not pick never reads as a gain here.
pub const PROOF_MIN_GAIN_MS: f64 = AUTO_MIN_GAIN_MS;
/// Replies each route needs before its numbers are judged.
pub const PROOF_MIN_REPLIES: u32 = 5;
/// Judged runs a month needs before its gain counts as shown. Fewer means no proof, so a refund is due.
pub const MONTH_MIN_RUNS: usize = 3;
pub const PROOF_LOG: &str = "proof-log.jsonl";

// ---------- stats ----------

/// Linear interpolation between ranks. The one quantile used by Proof, Auto and the refund rule.
pub fn quantile(sorted: &[f64], q: f64) -> f64 {
    let i = (sorted.len() - 1) as f64 * q;
    let lo = i.floor() as usize;
    let hi = (lo + 1).min(sorted.len() - 1);
    sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo as f64)
}

fn round1(v: Option<f64>) -> Option<f64> {
    v.map(|v| (v * 10.0).round() / 10.0)
}

/// Route stats as stored: rounded to 0.1 ms, loss to 0.1%. Every verdict is taken on these, so a
/// fresh run and the same run read back from the log are judged on the same numbers.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StoredStats {
    pub sent: u32,
    pub received: u32,
    /// Fraction lost, 0 to 1.
    pub loss: f64,
    pub min: Option<f64>,
    pub median: Option<f64>,
    pub p90: Option<f64>,
    /// Mean absolute change between consecutive replies.
    pub jitter: Option<f64>,
    /// Hop number of the last answering hop.
    pub hops: Option<u32>,
    /// Auto only: the score Auto picked by (median plus jitter and loss penalties). When both
    /// routes have one, the verdict compares scores, so it judges what Auto judged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

/// One probed host of an Auto run, both routes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HostStats {
    pub target: String,
    pub direct: StoredStats,
    pub relay: Option<StoredStats>,
}

pub fn route_stats(m: &RouteMeasure) -> StoredStats {
    let got: Vec<f64> = m.rtts.iter().flatten().copied().collect();
    let sent = if m.rtts.is_empty() { m.sent } else { m.rtts.len() as u32 };
    let received = if m.rtts.is_empty() { m.received } else { got.len() as u32 };
    let mut sorted = got.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q = |p: f64| (!sorted.is_empty()).then(|| quantile(&sorted, p));
    let jitter = (got.len() > 1).then(|| got.windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>() / (got.len() - 1) as f64);
    let loss = if sent == 0 { 0.0 } else { 1.0 - received as f64 / sent as f64 };
    StoredStats {
        sent,
        received,
        loss: (loss * 1000.0).round() / 1000.0,
        min: round1(sorted.first().copied().or(m.min)),
        median: round1(q(0.5).or(m.median)),
        p90: round1(q(0.9).or(m.p90)),
        jitter: round1(jitter.or(m.jitter)),
        hops: m.hops.iter().filter(|h| h.avg.is_some()).map(|h| h.hop).next_back(),
        score: None,
    }
}

/// Auto's path score as stored. Auto keeps no single-ping list, so min, p90, jitter and hops stay empty.
pub fn score_stats(s: &Score) -> StoredStats {
    StoredStats { sent: s.sent, received: s.received, loss: (s.loss * 1000.0).round() / 1000.0, min: None, median: round1(s.median), p90: None, jitter: None, hops: None, score: round1(s.score) }
}

/// The numbers a verdict compares: scores when both routes have one (Auto), else medians.
fn judged_pair(d: &StoredStats, r: &StoredStats) -> Option<(f64, f64, &'static str)> {
    match (d.score, r.score) {
        (Some(a), Some(b)) => Some((a, b, "score")),
        _ => Some((d.median?, r.median?, "median")),
    }
}

/// The saving a strict majority of `savings` reaches: the k-th largest, k = n/2 + 1. A relay wins
/// on a majority of hosts by `bar` exactly when this is `bar` or more. Auto and the verdict both use it.
pub fn majority_saving(savings: &[f64]) -> Option<f64> {
    let mut v = savings.to_vec();
    v.sort_by(|a, b| b.partial_cmp(a).unwrap());
    v.get(v.len() / 2).copied()
}

// ---------- verdict ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum VerdictKind {
    Gain,
    None,
    Worse,
    Unknown,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Verdict {
    pub kind: VerdictKind,
    /// Direct median minus relay median, positive when the relay is faster.
    pub saved_ms: Option<f64>,
    pub text: String,
}

fn ms(v: f64) -> String {
    format!("{v:.0} ms")
}

fn pct(v: f64) -> String {
    if v > 0.0 && v < 0.01 {
        format!("{:.1}%", v * 100.0)
    } else {
        format!("{:.0}%", v * 100.0)
    }
}

/// The verdict on one run. A gain needs both routes judged and a median saving of PROOF_MIN_GAIN_MS.
pub fn verdict(d: &StoredStats, r: Option<&StoredStats>, error: Option<&str>) -> Verdict {
    let unknown = |text: String| Verdict { kind: VerdictKind::Unknown, saved_ms: None, text };
    let Some(r) = r else {
        return unknown(format!("No relay measurement. {}", error.unwrap_or("The relay route could not be measured.")));
    };
    let Some((dm, rm, what)) = judged_pair(d, r) else {
        return unknown(format!("Not enough replies to judge ({} direct, {} via relay). Run it again.", d.received, r.received));
    };
    if d.received < PROOF_MIN_REPLIES || r.received < PROOF_MIN_REPLIES {
        return unknown(format!("Not enough replies to judge ({} direct, {} via relay). Run it again.", d.received, r.received));
    }
    let saved = round1(Some(dm - rm)).unwrap();
    let loss_note = if r.loss - d.loss >= 0.01 {
        format!(", but it loses {} of packets against {} direct", pct(r.loss), pct(d.loss))
    } else if d.loss - r.loss >= 0.01 {
        format!(" and cuts loss from {} to {}", pct(d.loss), pct(r.loss))
    } else {
        String::new()
    };
    let (kind, text) = if saved >= PROOF_MIN_GAIN_MS {
        (VerdictKind::Gain, format!("Relay saves {} {what} ({} direct, {} via relay){loss_note}.", ms(saved), ms(dm), ms(rm)))
    } else if saved <= -PROOF_MIN_GAIN_MS {
        (VerdictKind::Worse, format!("Relay is {} slower ({} vs {} direct). Stay on the direct route.", ms(-saved), ms(rm), ms(dm)))
    } else {
        (VerdictKind::None, format!("No gain measured. {} via relay vs {} direct is within {PROOF_MIN_GAIN_MS:.0} ms{loss_note}.", ms(rm), ms(dm)))
    };
    Verdict { kind, saved_ms: Some(saved), text }
}

/// The verdict on an Auto run that had no live game server: the relay must beat direct by the bar
/// on a strict majority of hosts, as Auto required to pick it. `saved_ms` is the saving that
/// majority reaches, so the run is a gain exactly when it is PROOF_MIN_GAIN_MS or more.
pub fn hosts_verdict(hosts: &[HostStats], error: Option<&str>) -> Verdict {
    let savings: Vec<f64> = hosts
        .iter()
        .filter_map(|h| {
            let r = h.relay.as_ref()?;
            if h.direct.received < PROOF_MIN_REPLIES || r.received < PROOF_MIN_REPLIES {
                return None;
            }
            judged_pair(&h.direct, r).and_then(|(d, r, _)| round1(Some(d - r)))
        })
        .collect();
    let Some(x) = majority_saving(&savings) else {
        return Verdict { kind: VerdictKind::Unknown, saved_ms: None, text: format!("No host had enough replies on both routes to judge. {}", error.unwrap_or("Run it again.")) };
    };
    let n = savings.len();
    let wins = savings.iter().filter(|s| **s >= PROOF_MIN_GAIN_MS).count();
    let losses = savings.iter().filter(|s| **s <= -PROOF_MIN_GAIN_MS).count();
    let of = |k: usize| format!("{k} of {n} host{}", if n == 1 { "" } else { "s" });
    let (kind, text) = if wins * 2 > n {
        (VerdictKind::Gain, format!("Relay saves {PROOF_MIN_GAIN_MS:.0} ms or more on {}, at least {} on a majority.", of(wins), ms(x)))
    } else if losses * 2 > n {
        (VerdictKind::Worse, format!("Relay is {PROOF_MIN_GAIN_MS:.0} ms or more slower on {}. Stay on the direct route.", of(losses)))
    } else {
        (VerdictKind::None, format!("No gain measured. Relay saves {PROOF_MIN_GAIN_MS:.0} ms or more on only {}, not a majority.", of(wins)))
    };
    Verdict { kind, saved_ms: Some(x), text }
}

/// The verdict on an Auto run League's in-match ping decided: the relay's in-game score against
/// direct's over the newest matches on each, with MIN_MATCHES on both, as Auto picked by.
pub fn matches_verdict(m: &MatchCount) -> Verdict {
    let (Some(d), Some(r), true) = (m.direct_ms, m.relay_ms, m.direct >= MIN_MATCHES && m.relay >= MIN_MATCHES) else {
        return Verdict { kind: VerdictKind::Unknown, saved_ms: None, text: format!("League's in-game ping decides: {} direct and {} relay matches so far, {MIN_MATCHES} each needed.", m.direct, m.relay) };
    };
    let saved = round1(Some(d - r)).unwrap();
    let over = format!("in game over {} relay and {} direct matches", m.relay, m.direct);
    let (kind, text) = if saved >= PROOF_MIN_GAIN_MS {
        (VerdictKind::Gain, format!("Relay saves {} {over} ({} direct, {} via relay).", ms(saved), ms(d), ms(r)))
    } else if saved <= -PROOF_MIN_GAIN_MS {
        (VerdictKind::Worse, format!("Relay is {} slower {over} ({} vs {} direct). Stay on the direct route.", ms(-saved), ms(r), ms(d)))
    } else {
        (VerdictKind::None, format!("No gain measured {over}. {} via relay vs {} direct is within {PROOF_MIN_GAIN_MS:.0} ms.", ms(r), ms(d)))
    };
    Verdict { kind, saved_ms: Some(saved), text }
}

// ---------- records ----------

/// One run, as kept in proof-log.jsonl. The refund rule reads these.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProofRecord {
    pub v: u8,
    /// When the run finished, ms epoch.
    pub ts: u64,
    pub target: String,
    pub relay_host: String,
    pub pings: u32,
    pub direct: StoredStats,
    pub relay: Option<StoredStats>,
    pub verdict: VerdictKind,
    pub saved_ms: Option<f64>,
    pub error: Option<String>,
    /// "compare" or "auto". Missing on records from before Auto logged its runs: a comparison.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Auto only: every address it probed. `target` is the first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<String>>,
    /// Auto runs without a live game server: each host's numbers. The verdict is then the
    /// majority-of-hosts rule Auto picked by, not the pooled `direct` and `relay`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosts: Option<Vec<HostStats>>,
    /// Auto runs League's in-match ping decided: the matches and in-game scores it judged. The
    /// verdict is then on these, and `direct` and `relay` hold the same in-game scores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matches: Option<MatchCount>,
}

impl ProofRecord {
    /// The verdict under today's rule, so records written under an older bar are judged alike.
    pub fn judge(&self) -> Verdict {
        if let Some(m) = &self.matches {
            return matches_verdict(m);
        }
        match self.hosts.as_deref() {
            Some(h) if !h.is_empty() && self.relay.is_some() => hosts_verdict(h, self.error.as_deref()),
            _ => verdict(&self.direct, self.relay.as_ref(), self.error.as_deref()),
        }
    }
}

/// A record with its verdict, as the UI shows it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct JudgedRecord {
    pub record: ProofRecord,
    pub verdict: Verdict,
}

fn judged(record: ProofRecord) -> JudgedRecord {
    let verdict = record.judge();
    JudgedRecord { record, verdict }
}

#[allow(clippy::too_many_arguments)]
fn make(ts: u64, target: String, relay_host: String, direct: StoredStats, relay: Option<StoredStats>, error: Option<String>, source: &str, targets: Option<Vec<String>>) -> ProofRecord {
    let mut rec = ProofRecord { v: 1, ts, target, relay_host, pings: direct.sent, direct, relay, verdict: VerdictKind::Unknown, saved_ms: None, error, source: Some(source.into()), targets, hosts: None, matches: None };
    let v = rec.judge();
    (rec.verdict, rec.saved_ms) = (v.kind, v.saved_ms);
    rec
}

pub fn from_comparison(c: &RelayComparison) -> ProofRecord {
    make(c.finished_at, c.target.clone(), c.relay_host.clone(), route_stats(&c.direct), c.relay.as_ref().map(route_stats), c.error.clone(), "compare", None)
}

/// An Auto run as a record. None when there was nothing to compare: no relay, or direct not measured.
/// When the live game server decided the pick, the record holds that host's numbers alone, so the
/// verdict judges what the pick was judged on.
pub fn from_auto(a: &AutoResult) -> Option<ProofRecord> {
    if let Some(m) = &a.pick.matches {
        return from_matches(a, m);
    }
    let dp = a.paths.iter().find(|p| p.candidate.kind == PathKind::Direct)?;
    // The relay Auto judged direct against, else the best measured one (paths come best first), else the first one.
    let relays = || a.paths.iter().filter(|p| p.candidate.kind == PathKind::Relay);
    let relay = relays().find(|p| a.pick.vs.as_ref() == Some(&p.candidate.id)).or_else(|| relays().find(|p| p.score.is_some())).or_else(|| relays().next())?;
    let on_live = |p: &crate::route_auto::PathResult| a.pick.live.as_ref().and_then(|t| p.hosts.iter().find(|h| &h.target == t)).map(|h| h.score.clone());
    let direct = match a.pick.live {
        Some(_) => on_live(dp).or_else(|| dp.score.clone())?,
        None => dp.score.clone()?,
    };
    let rs = if a.pick.live.is_some() { on_live(relay).or_else(|| relay.score.clone()) } else { relay.score.clone() };
    let r = rs.as_ref().map(score_stats);
    let error = if r.is_some() { a.error.clone() } else { relay.note.clone().or_else(|| a.error.clone()) };
    let target = a.pick.live.clone().or_else(|| a.targets.first().cloned()).unwrap_or_default();
    let mut rec = make(a.finished_at, target, relay.candidate.endpoint.clone().unwrap_or_default(), score_stats(&direct), r, error, "auto", Some(a.targets.clone()));
    // Without a live game server Auto voted per host, so the record keeps each host and is judged the same way.
    if a.pick.live.is_none() && rec.relay.is_some() && !dp.hosts.is_empty() {
        let at = |p: &crate::route_auto::PathResult, t: &str| p.hosts.iter().find(|h| h.target == t).map(|h| score_stats(&h.score));
        rec.hosts = Some(dp.hosts.iter().map(|h| HostStats { target: h.target.clone(), direct: score_stats(&h.score), relay: at(relay, &h.target) }).collect());
        let v = rec.judge();
        (rec.verdict, rec.saved_ms) = (v.kind, v.saved_ms);
    }
    Some(rec)
}

/// An Auto run League's in-match ping decided, judged on those matches, not on the probe hosts.
/// None without a relay to compare.
fn from_matches(a: &AutoResult, m: &MatchCount) -> Option<ProofRecord> {
    let relay = a.pick.vs.as_ref().and_then(|id| a.paths.iter().find(|p| &p.candidate.id == id))?;
    let game = |n: usize, v: Option<f64>| StoredStats { sent: n as u32, received: n as u32, loss: 0.0, min: None, median: round1(v), p90: None, jitter: None, hops: None, score: round1(v) };
    let mut rec = make(a.finished_at, "League in-game ping".into(), relay.candidate.endpoint.clone().unwrap_or_default(), game(m.direct, m.direct_ms), Some(game(m.relay, m.relay_ms)), a.error.clone(), "auto", Some(a.targets.clone()));
    rec.matches = Some(m.clone());
    let v = rec.judge();
    (rec.verdict, rec.saved_ms) = (v.kind, v.saved_ms);
    Some(rec)
}

// ---------- log ----------

/// Appends one record as a JSON line.
pub fn append(dir: &Path, record: &ProofRecord) -> Result<(), String> {
    use std::io::Write;
    let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(PROOF_LOG)).map_err(|e| e.to_string())?;
    f.write_all(format!("{line}\n").as_bytes()).map_err(|e| format!("Saving the proof record: {e}"))
}

/// Records, oldest first, and how many lines were not records (a torn last write, a hand edit).
pub fn parse_log(text: &str) -> (Vec<ProofRecord>, usize) {
    let mut skipped = 0;
    let recs = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| match serde_json::from_str::<ProofRecord>(l) {
            Ok(r) => Some(r),
            Err(_) => {
                skipped += 1;
                None
            }
        })
        .collect();
    (recs, skipped)
}

/// A missing log is no records. A log that exists but can't be read is an error, because an empty
/// list would read as "no runs" to the refund rule.
pub fn read_log(dir: &Path) -> Result<(Vec<ProofRecord>, usize), String> {
    match std::fs::read_to_string(dir.join(PROOF_LOG)) {
        Ok(t) => Ok(parse_log(&t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((Vec::new(), 0)),
        Err(e) => Err(format!("Reading the proof log: {e}")),
    }
}

// ---------- history and refund rule ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub runs: usize,
    /// Runs with a verdict (gain, none or worse).
    pub judged: usize,
    pub gains: usize,
    /// Median saving over judged runs.
    pub median_saved_ms: Option<f64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonthVerdict {
    /// Local calendar month, "YYYY-MM".
    pub month: String,
    pub runs: usize,
    pub judged: usize,
    pub gains: usize,
    pub median_saved_ms: Option<f64>,
    /// Enough judged runs and a median saving of PROOF_MIN_GAIN_MS or more.
    pub gained: bool,
    pub text: String,
    /// League's own in-game ping for the month's matches, by path. When both paths have enough
    /// matches it decides the month instead of the pre-match runs.
    pub in_game: Option<crate::matches::MatchMonth>,
}

fn tally(recs: &[&JudgedRecord]) -> (usize, usize, Option<f64>) {
    let judged: Vec<f64> = recs.iter().filter(|r| r.verdict.kind != VerdictKind::Unknown).filter_map(|r| r.verdict.saved_ms).collect();
    let gains = recs.iter().filter(|r| r.verdict.kind == VerdictKind::Gain).count();
    let mut sorted = judged.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (judged.len(), gains, (!sorted.is_empty()).then(|| quantile(&sorted, 0.5)))
}

/// Runs in the last `days` days before `now_ms`.
pub fn summarize(recs: &[JudgedRecord], now_ms: u64, days: u64) -> HistorySummary {
    let since = now_ms.saturating_sub(days * 86_400_000);
    let recent: Vec<&JudgedRecord> = recs.iter().filter(|r| r.record.ts >= since && r.record.ts <= now_ms).collect();
    let (judged, gains, median_saved_ms) = tally(&recent);
    HistorySummary { runs: recent.len(), judged, gains, median_saved_ms }
}

/// "YYYY-MM" of a ms timestamp shifted to local time. `tz_offset_min` is JavaScript's
/// getTimezoneOffset(): minutes to add to local time to get UTC, so positive west of Greenwich.
pub fn month_key(ts_ms: u64, tz_offset_min: i32) -> String {
    let local_ms = ts_ms as i64 - tz_offset_min as i64 * 60_000;
    let days = local_ms.div_euclid(86_400_000);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}")
}

/// The refund rule, per local calendar month, newest first: a month pays only when its runs show a gain.
pub fn month_verdicts(recs: &[JudgedRecord], tz_offset_min: i32) -> Vec<MonthVerdict> {
    month_verdicts_with(recs, &[], tz_offset_min)
}

/// The month verdicts with League's in-game ping. A month with at least MONTH_MIN_RUNS matches on
/// each path is judged on those matches: the relay must lower the median in-game ping by the bar.
pub fn month_verdicts_with(recs: &[JudgedRecord], games: &[crate::matches::MatchPing], tz_offset_min: i32) -> Vec<MonthVerdict> {
    let mut by: std::collections::BTreeMap<String, Vec<&JudgedRecord>> = std::collections::BTreeMap::new();
    for r in recs {
        by.entry(month_key(r.record.ts, tz_offset_min)).or_default().push(r);
    }
    let mut gm: std::collections::BTreeMap<String, Vec<&crate::matches::MatchPing>> = std::collections::BTreeMap::new();
    for g in games {
        gm.entry(month_key(g.ts, tz_offset_min)).or_default().push(g);
        by.entry(month_key(g.ts, tz_offset_min)).or_default();
    }
    by.into_iter()
        .rev()
        .map(|(month, rs)| {
            let in_game = gm.get(&month).map(|g| crate::matches::month_split(g));
            // A month with League matches is judged on them alone, never on probe-host runs.
            // Matches whose path changed mid-match are counted apart and judged on neither path.
            let left_out = |s: &crate::matches::MatchMonth| match s.mixed {
                0 => String::new(),
                1 => " 1 match switched path mid-match and doesn't count.".into(),
                n => format!(" {n} matches switched path mid-match and don't count."),
            };
            if let Some(s) = in_game.as_ref().filter(|s| s.direct + s.relay + s.mixed > 0 && (s.direct < MONTH_MIN_RUNS || s.relay < MONTH_MIN_RUNS)) {
                let (judged, gains, _) = tally(&rs);
                let text = format!("In game: {} direct and {} relay matches this month, {MONTH_MIN_RUNS} each needed.{} No gain shown, refund due.", s.direct, s.relay, left_out(s));
                return MonthVerdict { month, runs: rs.len(), judged, gains, median_saved_ms: None, gained: false, text, in_game };
            }
            if let Some(s) = in_game.as_ref().filter(|s| s.direct >= MONTH_MIN_RUNS && s.relay >= MONTH_MIN_RUNS) {
                let (d, r) = (s.direct_median_ms.unwrap(), s.relay_median_ms.unwrap());
                let saved = ((d - r) * 10.0).round() / 10.0;
                let gained = saved >= PROOF_MIN_GAIN_MS;
                let text = format!(
                    "In game: {r:.0} ms on the relay vs {d:.0} ms direct, median over {} relay and {} direct matches.{} {}",
                    s.relay,
                    s.direct,
                    left_out(s),
                    if gained { "Gain shown. No refund due." } else { "Under the bar. Refund due." }
                );
                let (judged, gains, _) = tally(&rs);
                return MonthVerdict { month, runs: rs.len(), judged, gains, median_saved_ms: Some(saved), gained, text, in_game };
            }
            let (judged, gains, median) = tally(&rs);
            let gained = judged >= MONTH_MIN_RUNS && median.is_some_and(|m| m >= PROOF_MIN_GAIN_MS);
            let text = if judged < MONTH_MIN_RUNS {
                format!("{} with a verdict, {MONTH_MIN_RUNS} needed. No gain shown, refund due.", if judged == 1 { "1 run".to_string() } else { format!("{judged} runs") })
            } else {
                let m = median.unwrap();
                if gained {
                    format!("Gain shown: median {m:.0} ms saved over {judged} runs ({gains} gained). No refund due.")
                } else {
                    let how = if m >= 0.0 { format!("{m:.0} ms saved") } else { format!("{:.0} ms slower", -m) };
                    format!("No gain shown: median {how} over {judged} runs, under the {PROOF_MIN_GAIN_MS:.0} ms bar. Refund due.")
                }
            };
            MonthVerdict { month, runs: rs.len(), judged, gains, median_saved_ms: median, gained, text, in_game }
        })
        .collect()
}

#[derive(Serialize, Clone, Debug)]
pub struct ProofHistory {
    /// Oldest first.
    pub records: Vec<JudgedRecord>,
    /// Newest first.
    pub months: Vec<MonthVerdict>,
    /// The last 30 days.
    pub recent: HistorySummary,
    /// Lines in the log that are not records.
    pub skipped: usize,
}

pub fn history(dir: &Path, now_ms: u64, tz_offset_min: i32) -> Result<ProofHistory, String> {
    let (recs, skipped) = read_log(dir)?;
    let records: Vec<JudgedRecord> = recs.into_iter().map(judged).collect();
    let games = crate::matches::read_log(dir);
    Ok(ProofHistory { months: month_verdicts_with(&records, &games, tz_offset_min), recent: summarize(&records, now_ms, 30), records, skipped })
}

/// Judges a finished run, appends it to the log and returns it with its verdict. The log write
/// failing does not lose the measurement: the error comes back beside it.
pub fn save(dir: &Path, record: ProofRecord) -> (JudgedRecord, Option<String>) {
    let err = append(dir, &record).err();
    (judged(record), err)
}

#[tauri::command]
pub fn proof_history(app: tauri::AppHandle, tz_offset_min: Option<i32>) -> Result<ProofHistory, String> {
    history(&crate::app_dir(&app), crate::relay::now_ms(), tz_offset_min.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(sent: u32, received: u32, median: Option<f64>) -> StoredStats {
        StoredStats { sent, received, loss: 1.0 - received as f64 / sent as f64, min: None, median, p90: None, jitter: None, hops: None, score: None }
    }

    fn rec(ts: u64, d: f64, r: f64) -> ProofRecord {
        make(ts, "104.160.131.3".into(), "203.0.113.10".into(), stats(50, 50, Some(d)), Some(stats(50, 50, Some(r))), None, "compare", None)
    }

    #[test]
    fn verdict_needs_the_auto_bar() {
        assert_eq!(PROOF_MIN_GAIN_MS, AUTO_MIN_GAIN_MS);
        let v = |d: f64, r: f64| verdict(&stats(50, 50, Some(d)), Some(&stats(50, 50, Some(r))), None);
        assert_eq!((v(80.0, 70.0).kind, v(80.0, 70.0).saved_ms), (VerdictKind::Gain, Some(10.0)));
        assert_eq!(v(80.0, 70.1).kind, VerdictKind::None);
        assert_eq!(v(70.0, 80.0).kind, VerdictKind::Worse);
        assert_eq!(v(80.0, 30.0).text, "Relay saves 50 ms median (80 ms direct, 30 ms via relay).");
    }

    #[test]
    fn verdict_unknown_without_relay_or_replies() {
        let d = stats(50, 50, Some(80.0));
        assert_eq!(verdict(&d, None, Some("Tunnel down.")).text, "No relay measurement. Tunnel down.");
        let few = verdict(&d, Some(&stats(50, 4, Some(30.0))), None);
        assert_eq!((few.kind, few.saved_ms), (VerdictKind::Unknown, None));
        assert!(few.text.starts_with("Not enough replies to judge (50 direct, 4 via relay)"));
    }

    #[test]
    fn loss_is_noted() {
        let v = verdict(&stats(100, 100, Some(80.0)), Some(&stats(100, 90, Some(40.0))), None);
        assert_eq!(v.text, "Relay saves 40 ms median (80 ms direct, 40 ms via relay), but it loses 10% of packets against 0% direct.");
    }

    #[test]
    fn route_stats_interpolate_and_round() {
        let m = RouteMeasure { sent: 5, received: 4, rtts: vec![Some(10.0), Some(13.0), None, Some(11.0), Some(20.04)], min: None, median: None, p90: None, jitter: None, hops: Vec::new() };
        let s = route_stats(&m);
        assert_eq!((s.sent, s.received, s.loss), (5, 4, 0.2));
        assert_eq!((s.min, s.median), (Some(10.0), Some(12.0)));
        // |13-10| + |11-13| + |20.04-11| over 3
        assert_eq!(s.jitter, Some(4.7));
    }

    #[test]
    fn log_round_trips_and_skips_bad_lines() {
        let dir = std::env::temp_dir().join(format!("rigrelay-proof-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (a, b) = (rec(1_000, 80.0, 30.0), rec(2_000, 31.0, 32.0));
        append(&dir, &a).unwrap();
        append(&dir, &b).unwrap();
        std::fs::OpenOptions::new().append(true).open(dir.join(PROOF_LOG)).and_then(|mut f| std::io::Write::write_all(&mut f, b"{\"torn\n")).unwrap();
        let (recs, skipped) = read_log(&dir).unwrap();
        assert_eq!((recs, skipped), (vec![a, b], 1));
        assert_eq!(read_log(&dir.join("missing")).unwrap(), (Vec::new(), 0));
        std::fs::remove_file(dir.join(PROOF_LOG)).unwrap();
        std::fs::create_dir(dir.join(PROOF_LOG)).unwrap();
        assert!(read_log(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_records_written_by_the_old_ui() {
        let line = r#"{"v":1,"ts":1794000000000,"target":"104.160.131.3","relay_host":"203.0.113.10","pings":50,"direct":{"sent":50,"received":48,"loss":0.04,"min":70.1,"median":79,"p90":85.2,"jitter":3.1,"hops":12},"relay":{"sent":50,"received":50,"loss":0,"min":29,"median":30.5,"p90":32,"jitter":0.8,"hops":5},"verdict":"gain","saved_ms":48.5,"error":null}"#;
        let (recs, skipped) = parse_log(line);
        assert_eq!(skipped, 0);
        assert_eq!(recs[0].source, None);
        assert_eq!(recs[0].judge().kind, VerdictKind::Gain);
    }

    #[test]
    fn month_key_follows_local_time() {
        // 2026-11-01 03:00 UTC is still October in New York (UTC-4, offset +240).
        let ts = 1_793_502_000_000;
        assert_eq!(month_key(ts, 0), "2026-11");
        assert_eq!(month_key(ts, 240), "2026-10");
        assert_eq!(month_key(0, 0), "1970-01");
        assert_eq!(month_key(951_782_400_000, 0), "2000-02"); // 2000-02-29
    }

    #[test]
    fn month_needs_three_judged_runs_and_the_bar() {
        let day = 86_400_000;
        let nov = 1_793_534_400_000; // 2026-11-01 12:00 UTC
        let j = |r: ProofRecord| judged(r);
        let few = month_verdicts(&[j(rec(nov, 80.0, 30.0)), j(rec(nov + day, 80.0, 30.0))], 0);
        assert!(!few[0].gained && few[0].text.starts_with("2 runs with a verdict, 3 needed"));
        let won = month_verdicts(&[j(rec(nov, 80.0, 30.0)), j(rec(nov + day, 80.0, 30.0)), j(rec(nov + 2 * day, 31.0, 32.0))], 0);
        assert_eq!((won[0].month.as_str(), won[0].gained, won[0].gains, won[0].median_saved_ms), ("2026-11", true, 2, Some(50.0)));
        let lost = month_verdicts(&[j(rec(nov, 80.0, 75.0)), j(rec(nov + day, 80.0, 75.0)), j(rec(nov + 2 * day, 80.0, 30.0))], 0);
        assert!(!lost[0].gained && lost[0].text.contains("under the 10 ms bar. Refund due."));
        let two = month_verdicts(&[j(rec(nov, 80.0, 30.0)), j(rec(nov - 40 * day, 80.0, 30.0))], 0);
        assert_eq!(two.iter().map(|m| m.month.as_str()).collect::<Vec<_>>(), ["2026-11", "2026-09"]);
        // Enough matches on both paths: League's own ping decides the month.
        let g = |path: &str, med: f64| crate::matches::MatchPing { v: 1, id: "a".into(), ts: nov, path: path.into(), samples: 60, min_ms: med, median_ms: med, p95_ms: med, jitter_ms: None, loss: 0.0, duration_s: 1500.0 };
        let games = [g("direct", 45.0), g("direct", 47.0), g("direct", 46.0), g("relay-chi-1", 31.0), g("relay-chi-1", 33.0), g("relay-chi-1", 32.0)];
        let by_game = month_verdicts_with(&[j(rec(nov, 80.0, 75.0))], &games, 0);
        assert!(by_game[0].gained, "{}", by_game[0].text);
        assert_eq!(by_game[0].median_saved_ms, Some(14.0));
        let few_games = month_verdicts_with(&[j(rec(nov, 80.0, 75.0))], &games[..4], 0);
        assert!(!few_games[0].gained && few_games[0].in_game.as_ref().unwrap().relay == 1, "one relay match isn't enough");
        // A month with League matches is never judged on probe runs, even when they show a gain.
        let probe_gain = [j(rec(nov, 80.0, 30.0)), j(rec(nov + day, 80.0, 30.0)), j(rec(nov + 2 * day, 80.0, 30.0))];
        assert!(month_verdicts(&probe_gain, 0)[0].gained, "without matches the runs decide");
        let thin = month_verdicts_with(&probe_gain, &games[..4], 0);
        assert!(!thin[0].gained && thin[0].text.starts_with("In game: 3 direct and 1 relay matches this month"), "{}", thin[0].text);
    }

    #[test]
    fn mixed_matches_never_count_toward_the_month() {
        let nov = 1_793_534_400_000;
        let g = |path: &str, med: f64| crate::matches::MatchPing { v: 1, id: "a".into(), ts: nov, path: path.into(), samples: 60, min_ms: med, median_ms: med, p95_ms: med, jitter_ms: None, loss: 0.0, duration_s: 1500.0 };
        let mixed = crate::matches::MIXED;
        // Two clean relay matches plus a fast mixed one: not three relay matches, so refund due.
        let games = [g("direct", 45.0), g("direct", 47.0), g("direct", 46.0), g("relay-chi-1", 31.0), g("relay-chi-1", 33.0), g(mixed, 10.0)];
        let v = month_verdicts_with(&[], &games, 0);
        assert!(!v[0].gained, "{}", v[0].text);
        assert_eq!(v[0].text, "In game: 3 direct and 2 relay matches this month, 3 each needed. 1 match switched path mid-match and doesn't count. No gain shown, refund due.");
        // Enough clean matches: the mixed ones don't move the medians.
        let more = [g("direct", 45.0), g("direct", 47.0), g("direct", 46.0), g("relay-chi-1", 31.0), g("relay-chi-1", 33.0), g("relay-chi-1", 32.0), g(mixed, 90.0), g(mixed, 90.0)];
        let v = month_verdicts_with(&[], &more, 0);
        assert_eq!((v[0].gained, v[0].median_saved_ms), (true, Some(14.0)));
        assert!(v[0].text.contains("2 matches switched path mid-match and don't count."), "{}", v[0].text);
        // A month of only mixed matches is still a League month: never judged on probe runs.
        let probe_gain: Vec<JudgedRecord> = (0..3).map(|i| judged(rec(nov + i * 86_400_000, 80.0, 30.0))).collect();
        let v = month_verdicts_with(&probe_gain, &[g(mixed, 20.0)], 0);
        assert!(!v[0].gained && v[0].text.starts_with("In game: 0 direct and 0 relay"), "{}", v[0].text);
    }

    #[test]
    fn summary_counts_the_last_days() {
        let now = 1_793_534_400_000;
        let day = 86_400_000;
        let recs: Vec<JudgedRecord> = [rec(now - day, 80.0, 30.0), rec(now - 40 * day, 80.0, 30.0), rec(now - 2 * day, 31.0, 32.0)].into_iter().map(judged).collect();
        assert_eq!(summarize(&recs, now, 30), HistorySummary { runs: 2, judged: 2, gains: 1, median_saved_ms: Some(24.5) });
    }
}
