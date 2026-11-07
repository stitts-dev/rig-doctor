// Relay proof: the same game server measured direct and through the relay, back to back,
// and a verdict that only claims a gain the numbers show.

import type { AutoResult } from "./relay";
import type { RelayComparison, RouteMeasure } from "./types";

/**
 * Smallest median saving that counts as a gain, for a single run and for the monthly refund
 * verdict. Below this, run-to-run noise can explain it. It is the bar Auto picks a relay by, so
 * it must equal AUTO_MIN_GAIN_MS in src-tauri/src/route_auto.rs (a Rust test checks this line).
 */
export const PROOF_MIN_GAIN_MS = 10;
/** Replies a route needs before its numbers are judged. */
export const PROOF_MIN_REPLIES = 5;
/** Tunnel addresses (relay/setup.sh puts the relay at 10.66.66.1). A hop here is the relay itself. */
export const RELAY_NET = /^10\.66\.66\.\d+$/;

export interface RouteStats {
  sent: number;
  received: number;
  /** Fraction lost, 0 to 1. */
  loss: number;
  min?: number;
  median?: number;
  p90?: number;
  jitter?: number;
  /** Hop number of the last answering hop: how many routers the route crosses. */
  hops?: number;
}

const quantile = (sorted: number[], q: number): number => {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
};

/** Stats from the raw pings, so every number on screen comes from the same samples. Backend fields fill in when rtts is empty. */
export function routeStats(m: RouteMeasure): RouteStats {
  const got = m.rtts.filter((v): v is number => v != null);
  const sent = m.rtts.length || m.sent;
  const received = m.rtts.length ? got.length : m.received;
  const sorted = [...got].sort((a, b) => a - b);
  let jitter: number | undefined;
  if (got.length > 1) jitter = got.slice(1).reduce((s, v, i) => s + Math.abs(v - got[i]), 0) / (got.length - 1);
  const last = m.hops.filter((h) => h.avg != null).pop();
  return {
    sent,
    received,
    loss: sent ? 1 - received / sent : 0,
    min: sorted.length ? sorted[0] : m.min ?? undefined,
    median: sorted.length ? quantile(sorted, 0.5) : m.median ?? undefined,
    p90: sorted.length ? quantile(sorted, 0.9) : m.p90 ?? undefined,
    jitter: jitter ?? m.jitter ?? undefined,
    hops: last?.hop,
  };
}

export type VerdictKind = "gain" | "none" | "worse" | "unknown";

export interface ProofVerdict {
  kind: VerdictKind;
  /** Direct median minus relay median, positive when the relay is faster. */
  savedMs?: number;
  /** One line for the panel. */
  text: string;
}

const ms = (v: number) => `${v.toFixed(0)} ms`;
const pct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.01 ? 1 : 0)}%`;

export function proofVerdict(c: RelayComparison): ProofVerdict {
  return verdictOf(routeStats(c.direct), c.relay ? routeStats(c.relay) : null, c.error);
}

/** The verdict from two routes' stats, so a stored record is judged the same way as a fresh run. */
export function verdictOf(d: RouteStats, r: RouteStats | null, error: string | null): ProofVerdict {
  if (!r) return { kind: "unknown", text: `No relay measurement. ${error ?? "The relay route could not be measured."}` };
  if (d.received < PROOF_MIN_REPLIES || r.received < PROOF_MIN_REPLIES || d.median == null || r.median == null)
    return { kind: "unknown", text: `Not enough replies to judge (${d.received} direct, ${r.received} via relay). Run it again.` };
  const saved = d.median - r.median;
  const lossUp = r.loss - d.loss;
  const lossNote = lossUp >= 0.01 ? `, but it loses ${pct(r.loss)} of packets against ${pct(d.loss)} direct` : d.loss - r.loss >= 0.01 ? ` and cuts loss from ${pct(d.loss)} to ${pct(r.loss)}` : "";
  if (saved >= PROOF_MIN_GAIN_MS) return { kind: "gain", savedMs: saved, text: `Relay saves ${ms(saved)} median (${ms(d.median)} direct, ${ms(r.median)} via relay)${lossNote}.` };
  if (saved <= -PROOF_MIN_GAIN_MS) return { kind: "worse", savedMs: saved, text: `Relay is ${ms(-saved)} slower (${ms(r.median)} vs ${ms(d.median)} direct). Stay on the direct route.` };
  return { kind: "none", savedMs: saved, text: `No gain measured. ${ms(r.median)} via relay vs ${ms(d.median)} direct is within ${PROOF_MIN_GAIN_MS} ms${lossNote}.` };
}

// ---------- history ----------

/** Route stats as stored: nulls where a value is missing, so the record is plain JSON. */
export interface StoredStats {
  sent: number;
  received: number;
  loss: number;
  min: number | null;
  median: number | null;
  p90: number | null;
  jitter: number | null;
  hops: number | null;
}

/** One comparison, as kept in proof-log.jsonl. The auto-refund rule reads these. */
export interface ProofRecord {
  v: 1;
  /** When the comparison finished, ms epoch. */
  ts: number;
  target: string;
  relay_host: string;
  pings: number;
  direct: StoredStats;
  relay: StoredStats | null;
  verdict: VerdictKind;
  /** Direct median minus relay median; positive when the relay is faster. */
  saved_ms: number | null;
  error: string | null;
  /** What made the record. Missing on records from before Auto logged its runs: a comparison. */
  source?: "compare" | "auto";
  /** Auto only: every address it probed. `target` is the first, the live game server when one was seen. */
  targets?: string[];
}

const round1 = (v: number | undefined): number | null => (v == null ? null : Math.round(v * 10) / 10);
const store = (s: RouteStats): StoredStats => ({ sent: s.sent, received: s.received, loss: Math.round(s.loss * 1000) / 1000, min: round1(s.min), median: round1(s.median), p90: round1(s.p90), jitter: round1(s.jitter), hops: s.hops ?? null });
export const unstore = (s: StoredStats): RouteStats => ({ sent: s.sent, received: s.received, loss: s.loss, min: s.min ?? undefined, median: s.median ?? undefined, p90: s.p90 ?? undefined, jitter: s.jitter ?? undefined, hops: s.hops ?? undefined });

export function toRecord(c: RelayComparison): ProofRecord {
  const d = routeStats(c.direct);
  const r = c.relay ? routeStats(c.relay) : null;
  const v = verdictOf(d, r, c.error);
  return { v: 1, ts: c.finished_at, target: c.target, relay_host: c.relay_host, pings: d.sent, direct: store(d), relay: r ? store(r) : null, verdict: v.kind, saved_ms: round1(v.savedMs), error: c.error, source: "compare" };
}

/** Auto's path score as stored stats. Auto keeps no single-ping list, so min, p90, jitter and hops stay empty. */
const storeScore = (s: NonNullable<AutoResult["paths"][number]["score"]>): StoredStats => ({ sent: s.sent, received: s.received, loss: Math.round(s.loss * 1000) / 1000, min: null, median: round1(s.median ?? undefined), p90: null, jitter: null, hops: null });

/**
 * An Auto run as a proof record, judged on the same median rule as a comparison. Null when there
 * was nothing to compare: no relay configured, or the direct route was not measured.
 */
export function autoRecord(a: AutoResult): ProofRecord | null {
  const direct = a.paths.find((p) => p.candidate.kind === "direct");
  const relay = a.paths.find((p) => p.candidate.kind === "relay");
  if (!direct?.score || !relay) return null;
  const d = storeScore(direct.score);
  const r = relay.score ? storeScore(relay.score) : null;
  const error = r ? a.error : relay.note ?? a.error;
  const v = verdictOf(unstore(d), r ? unstore(r) : null, error);
  return { v: 1, ts: a.finished_at, target: a.targets[0] ?? "", relay_host: relay.candidate.endpoint ?? "", pings: d.sent, direct: d, relay: r, verdict: v.kind, saved_ms: round1(v.savedMs), error, source: "auto", targets: a.targets };
}

export const recordVerdict = (rec: ProofRecord): ProofVerdict => verdictOf(unstore(rec.direct), rec.relay ? unstore(rec.relay) : null, rec.error);

export interface HistorySummary {
  runs: number;
  /** Runs with a verdict (gain, none or worse). */
  judged: number;
  gains: number;
  /** Median of saved_ms over judged runs. */
  medianSavedMs?: number;
}

/** Runs in the last `days` days before `now`. The refund rule asks: did this period show a gain? */
export function summarizeHistory(records: ProofRecord[], now: number, days = 30): HistorySummary {
  const since = now - days * 86400000;
  const recent = records.filter((r) => r.ts >= since && r.ts <= now);
  const judged = recent.filter((r) => r.verdict !== "unknown" && r.saved_ms != null);
  const saved = judged.map((r) => r.saved_ms!).sort((a, b) => a - b);
  return { runs: recent.length, judged: judged.length, gains: judged.filter((r) => recordVerdict(r).kind === "gain").length, medianSavedMs: saved.length ? quantile(saved, 0.5) : undefined };
}

// ---------- monthly verdict ----------

/** Judged runs a month needs before its gain counts as shown. Fewer means no proof, so a refund is due. */
export const MONTH_MIN_RUNS = 3;

export interface MonthVerdict {
  /** Local calendar month, "YYYY-MM". */
  month: string;
  runs: number;
  judged: number;
  gains: number;
  medianSavedMs?: number;
  /** The month showed a gain: enough judged runs and a median saving of PROOF_MIN_GAIN_MS or more. */
  gained: boolean;
  /** One line for the panel. */
  text: string;
}

const monthKey = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/**
 * The refund rule, per local calendar month: a month pays only when its runs show a gain. A month
 * with fewer than MONTH_MIN_RUNS judged runs has not shown one, so it counts as no gain.
 */
export function monthVerdicts(records: ProofRecord[]): MonthVerdict[] {
  const by = new Map<string, ProofRecord[]>();
  for (const r of records) by.set(monthKey(r.ts), [...(by.get(monthKey(r.ts)) ?? []), r]);
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([month, recs]) => {
      const judged = recs.filter((r) => r.verdict !== "unknown" && r.saved_ms != null);
      const saved = judged.map((r) => r.saved_ms!).sort((a, b) => a - b);
      const median = saved.length ? quantile(saved, 0.5) : undefined;
      const gained = judged.length >= MONTH_MIN_RUNS && median != null && median >= PROOF_MIN_GAIN_MS;
      const gains = judged.filter((r) => recordVerdict(r).kind === "gain").length;
      const text =
        judged.length < MONTH_MIN_RUNS
          ? `${judged.length === 1 ? "1 run" : `${judged.length} runs`} with a verdict, ${MONTH_MIN_RUNS} needed. No gain shown, refund due.`
          : gained
            ? `Gain shown: median ${median!.toFixed(0)} ms saved over ${judged.length} runs (${gains} gained). No refund due.`
            : `No gain shown: median ${median! >= 0 ? `${median!.toFixed(0)} ms saved` : `${(-median!).toFixed(0)} ms slower`} over ${judged.length} runs, under the ${PROOF_MIN_GAIN_MS} ms bar. Refund due.`;
      return { month, runs: recs.length, judged: judged.length, gains, medianSavedMs: median, gained, text };
    });
}
