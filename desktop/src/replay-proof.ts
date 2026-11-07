// Replay only. In a plain browser there is no backend, so the replay judges its own made-up runs
// with a copy of the rule in src-tauri/src/proof.rs. The app never uses this file: inside Tauri
// every record, verdict and month comes from the backend.

import type { AutoResult } from "./relay";
import type { RelayComparison } from "./types";
import { routeStats, type HistorySummary, type JudgedRecord, type MonthVerdict, type ProofHistory, type ProofRecord, type ProofVerdict, type RouteStats, type StoredStats, type HostStats } from "./proof";

const GAIN_MS = 10;
const MIN_REPLIES = 5;
const MONTH_MIN_RUNS = 3;

const r1 = (v: number | null | undefined): number | null => (v == null ? null : Math.round(v * 10) / 10);
const ms = (v: number) => `${v.toFixed(0)} ms`;
const pct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.01 ? 1 : 0)}%`;
const quantile = (s: number[], q: number) => {
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
};

const store = (s: RouteStats): StoredStats => ({ sent: s.sent, received: s.received, loss: Math.round(s.loss * 1000) / 1000, min: r1(s.min), median: r1(s.median), p90: r1(s.p90), jitter: r1(s.jitter), hops: s.hops ?? null });

/** Scores when both routes have one (Auto), else medians. */
const pair = (d: StoredStats, r: StoredStats): [number, number, string] | null =>
  d.score != null && r.score != null ? [d.score, r.score, "score"] : d.median != null && r.median != null ? [d.median, r.median, "median"] : null;

function judgeHosts(hosts: HostStats[]): ProofVerdict {
  const savings = hosts
    .map((h) => (h.relay && h.direct.received >= MIN_REPLIES && h.relay.received >= MIN_REPLIES ? pair(h.direct, h.relay) : null))
    .filter((p): p is [number, number, string] => p != null)
    .map(([d, r]) => r1(d - r)!);
  const n = savings.length;
  if (!n) return { kind: "unknown", saved_ms: null, text: "No host had enough replies on both routes to judge. Run it again." };
  const x = [...savings].sort((a, b) => b - a)[Math.floor(n / 2)];
  const wins = savings.filter((s) => s >= GAIN_MS).length;
  const losses = savings.filter((s) => s <= -GAIN_MS).length;
  const of = (k: number) => `${k} of ${n} host${n === 1 ? "" : "s"}`;
  if (wins * 2 > n) return { kind: "gain", saved_ms: x, text: `Relay saves ${GAIN_MS} ms or more on ${of(wins)}, at least ${ms(x)} on a majority.` };
  if (losses * 2 > n) return { kind: "worse", saved_ms: x, text: `Relay is ${GAIN_MS} ms or more slower on ${of(losses)}. Stay on the direct route.` };
  return { kind: "none", saved_ms: x, text: `No gain measured. Relay saves ${GAIN_MS} ms or more on only ${of(wins)}, not a majority.` };
}

function judge(d: StoredStats, r: StoredStats | null, error: string | null, hosts?: HostStats[]): ProofVerdict {
  if (!r) return { kind: "unknown", saved_ms: null, text: `No relay measurement. ${error ?? "The relay route could not be measured."}` };
  if (hosts?.length) return judgeHosts(hosts);
  const p = pair(d, r);
  if (d.received < MIN_REPLIES || r.received < MIN_REPLIES || !p)
    return { kind: "unknown", saved_ms: null, text: `Not enough replies to judge (${d.received} direct, ${r.received} via relay). Run it again.` };
  const [dm, rm, what] = p;
  const saved = r1(dm - rm)!;
  const lossNote = r.loss - d.loss >= 0.01 ? `, but it loses ${pct(r.loss)} of packets against ${pct(d.loss)} direct` : d.loss - r.loss >= 0.01 ? ` and cuts loss from ${pct(d.loss)} to ${pct(r.loss)}` : "";
  if (saved >= GAIN_MS) return { kind: "gain", saved_ms: saved, text: `Relay saves ${ms(saved)} ${what} (${ms(dm)} direct, ${ms(rm)} via relay)${lossNote}.` };
  if (saved <= -GAIN_MS) return { kind: "worse", saved_ms: saved, text: `Relay is ${ms(-saved)} slower (${ms(rm)} vs ${ms(dm)} direct). Stay on the direct route.` };
  return { kind: "none", saved_ms: saved, text: `No gain measured. ${ms(rm)} via relay vs ${ms(dm)} direct is within ${GAIN_MS} ms${lossNote}.` };
}

function judged(record: ProofRecord): JudgedRecord {
  return { record, verdict: judge(record.direct, record.relay, record.error, record.hosts) };
}

export function replayCompareRecord(c: RelayComparison): JudgedRecord {
  const d = store(routeStats(c.direct));
  const r = c.relay ? store(routeStats(c.relay)) : null;
  const v = judge(d, r, c.error);
  return judged({ v: 1, ts: c.finished_at, target: c.target, relay_host: c.relay_host, pings: d.sent, direct: d, relay: r, verdict: v.kind, saved_ms: v.saved_ms, error: c.error, source: "compare" });
}

export function replayAutoRecord(a: AutoResult): JudgedRecord | undefined {
  const dp = a.paths.find((p) => p.candidate.kind === "direct");
  const relays = a.paths.filter((p) => p.candidate.kind === "relay");
  const relay = relays.find((p) => p.candidate.id === a.pick.vs) ?? relays.find((p) => p.score) ?? relays[0];
  // Like proof::from_auto: the live game server's numbers alone when it decided the pick.
  const pick = (p: (typeof a.paths)[number]) => (a.pick.live ? p.hosts?.find((h) => h.target === a.pick.live)?.score ?? p.score : p.score);
  const direct = dp && pick(dp);
  if (!direct || !relay) return undefined;
  const sc = (s: NonNullable<typeof direct>): StoredStats => ({ sent: s.sent, received: s.received, loss: Math.round(s.loss * 1000) / 1000, min: null, median: r1(s.median), p90: null, jitter: null, hops: null, score: r1(s.score) });
  const d = sc(direct);
  const rs = pick(relay);
  const r = rs ? sc(rs) : null;
  const error = r ? a.error : relay.note ?? a.error;
  // Like proof::from_auto: without a live game server, keep each host and judge by the majority rule.
  const hosts: HostStats[] | undefined =
    !a.pick.live && r && dp?.hosts?.length ? dp.hosts.map((h) => ({ target: h.target, direct: sc(h.score), relay: (() => { const x = relay.hosts?.find((y) => y.target === h.target)?.score; return x ? sc(x) : null; })() })) : undefined;
  const v = judge(d, r, error, hosts);
  return judged({ v: 1, ts: a.finished_at, target: a.pick.live ?? a.targets[0] ?? "", relay_host: relay.candidate.endpoint ?? "", pings: d.sent, direct: d, relay: r, verdict: v.kind, saved_ms: v.saved_ms, error, source: "auto", targets: a.targets, ...(hosts ? { hosts } : {}) });
}

function tally(recs: JudgedRecord[]): [number, number, number | null] {
  const saved = recs.filter((r) => r.verdict.kind !== "unknown" && r.verdict.saved_ms != null).map((r) => r.verdict.saved_ms!).sort((a, b) => a - b);
  return [saved.length, recs.filter((r) => r.verdict.kind === "gain").length, saved.length ? quantile(saved, 0.5) : null];
}

export function replayHistory(records: JudgedRecord[], now: number): ProofHistory {
  const recent = records.filter((r) => r.record.ts >= now - 30 * 86400000 && r.record.ts <= now);
  const [judgedN, gains, median] = tally(recent);
  const summary: HistorySummary = { runs: recent.length, judged: judgedN, gains, medianSavedMs: median };
  const by = new Map<string, JudgedRecord[]>();
  for (const r of records) {
    const d = new Date(r.record.ts);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  const months: MonthVerdict[] = [...by.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([month, rs]) => {
      const [j, g, m] = tally(rs);
      const gained = j >= MONTH_MIN_RUNS && m != null && m >= GAIN_MS;
      const text =
        j < MONTH_MIN_RUNS
          ? `${j === 1 ? "1 run" : `${j} runs`} with a verdict, ${MONTH_MIN_RUNS} needed. No gain shown, refund due.`
          : gained
            ? `Gain shown: median ${m!.toFixed(0)} ms saved over ${j} runs (${g} gained). No refund due.`
            : `No gain shown: median ${m! >= 0 ? `${m!.toFixed(0)} ms saved` : `${(-m!).toFixed(0)} ms slower`} over ${j} runs, under the ${GAIN_MS} ms bar. Refund due.`;
      return { month, runs: rs.length, judged: j, gains: g, medianSavedMs: m, gained, text };
    });
  return { records, months, recent: summary, skipped: 0 };
}
