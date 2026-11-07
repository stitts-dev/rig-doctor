// Relay proof, as the UI shows it. The backend (src-tauri/src/proof.rs) measures, judges and saves
// every run and computes the monthly refund rule; this file only holds the shapes it returns and
// the stats used to draw a route's hops.

import type { RouteMeasure } from "./types";

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

/** Display stats from the raw pings of a route being drawn. Verdicts never come from here. */
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

/** The backend's verdict on one run. */
export interface ProofVerdict {
  kind: VerdictKind;
  /** Direct median minus relay median, positive when the relay is faster. */
  saved_ms: number | null;
  /** One line for the panel. */
  text: string;
}

/** Route stats as stored: nulls where a value is missing. */
export interface StoredStats {
  sent: number;
  received: number;
  loss: number;
  min: number | null;
  median: number | null;
  p90: number | null;
  jitter: number | null;
  hops: number | null;
  /** Auto only: the score Auto picked by. When both routes have one, the verdict compares scores. */
  score?: number | null;
}

/** One probed host of an Auto run, both routes. */
export interface HostStats {
  target: string;
  direct: StoredStats;
  relay: StoredStats | null;
}

/** One run, as kept in proof-log.jsonl. Written only by the backend. */
export interface ProofRecord {
  v: 1;
  /** When the run finished, ms epoch. */
  ts: number;
  target: string;
  relay_host: string;
  pings: number;
  direct: StoredStats;
  relay: StoredStats | null;
  verdict: VerdictKind;
  saved_ms: number | null;
  error: string | null;
  /** What made the record. Missing on records from before Auto logged its runs: a comparison. */
  source?: "compare" | "auto";
  /** Auto only: every address it probed. `target` is the first. */
  targets?: string[];
  /** Auto runs without a live game server: each host. The verdict is then the majority-of-hosts rule. */
  hosts?: HostStats[];
}

/** A record with the verdict the backend gives it under today's rule. */
export interface JudgedRecord {
  record: ProofRecord;
  verdict: ProofVerdict;
}

export interface HistorySummary {
  runs: number;
  /** Runs with a verdict (gain, none or worse). */
  judged: number;
  gains: number;
  medianSavedMs: number | null;
}

export interface MonthVerdict {
  /** Local calendar month, "YYYY-MM". */
  month: string;
  runs: number;
  judged: number;
  gains: number;
  medianSavedMs: number | null;
  gained: boolean;
  text: string;
}

/** proof_history: the log with verdicts, the refund rule per month, and the last 30 days. */
export interface ProofHistory {
  /** Oldest first. */
  records: JudgedRecord[];
  /** Newest first. */
  months: MonthVerdict[];
  recent: HistorySummary;
  /** Lines in the log that are not records. */
  skipped: number;
}

export const unstore = (s: StoredStats): RouteStats => ({ sent: s.sent, received: s.received, loss: s.loss, min: s.min ?? undefined, median: s.median ?? undefined, p90: s.p90 ?? undefined, jitter: s.jitter ?? undefined, hops: s.hops ?? undefined });
