// Relay proof: the same game server measured direct and through the relay, back to back,
// and a verdict that only claims a gain the numbers show.

import type { RelayComparison, RouteMeasure } from "./types";

/** Smallest median saving reported as a gain. Below this, run-to-run noise can explain it. */
export const PROOF_MIN_GAIN_MS = 5;
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
  if (!c.relay) return { kind: "unknown", text: `No relay measurement. ${c.error ?? "The relay route could not be measured."}` };
  const d = routeStats(c.direct);
  const r = routeStats(c.relay);
  if (d.received < PROOF_MIN_REPLIES || r.received < PROOF_MIN_REPLIES || d.median == null || r.median == null)
    return { kind: "unknown", text: `Not enough replies to judge (${d.received} direct, ${r.received} via relay). Run it again.` };
  const saved = d.median - r.median;
  const lossUp = r.loss - d.loss;
  const lossNote = lossUp >= 0.01 ? `, but it loses ${pct(r.loss)} of packets against ${pct(d.loss)} direct` : d.loss - r.loss >= 0.01 ? ` and cuts loss from ${pct(d.loss)} to ${pct(r.loss)}` : "";
  if (saved >= PROOF_MIN_GAIN_MS) return { kind: "gain", savedMs: saved, text: `Relay saves ${ms(saved)} median (${ms(d.median)} direct, ${ms(r.median)} via relay)${lossNote}.` };
  if (saved <= -PROOF_MIN_GAIN_MS) return { kind: "worse", savedMs: saved, text: `Relay is ${ms(-saved)} slower (${ms(r.median)} vs ${ms(d.median)} direct). Stay on the direct route.` };
  return { kind: "none", savedMs: saved, text: `No gain measured. ${ms(r.median)} via relay vs ${ms(d.median)} direct is within ${PROOF_MIN_GAIN_MS} ms${lossNote}.` };
}
