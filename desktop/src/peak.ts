// Peak-hour trace log: when the scheduled task runs, and what the samples it wrote say.
// Pure functions, so they can be checked without the app.

import { samePath } from "./route";
import type { Hop, PeakConfig, PeakSample, SchedulePlan } from "./types";

export const DEFAULT_PEAK: PeakConfig = { target: "104.160.131.3", start: "18:00", end: "24:00", every_min: 10, days: 7 };

/** Minutes after midnight for "HH:MM". "24:00" is 1440. */
export function minutesOf(hhmm: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return undefined;
  const v = +m[1] * 60 + +m[2];
  return +m[2] < 60 && v <= 1440 ? v : undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local time as Task Scheduler wants it: "YYYY-MM-DDTHH:MM:SS", no zone. */
export const localIso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * The task's trigger for `cfg.days` windows. The first window is today's when it has not ended
 * yet, otherwise tomorrow's. A window that ends before it starts (22:00 to 02:00) runs past midnight.
 */
export function planSchedule(cfg: PeakConfig, now: Date): SchedulePlan | string {
  const start = minutesOf(cfg.start);
  const end = minutesOf(cfg.end);
  if (start == null || start >= 1440) return "Start must be a time from 00:00 to 23:59.";
  if (end == null) return "End must be a time from 00:00 to 24:00.";
  if (!Number.isInteger(cfg.every_min) || cfg.every_min < 1 || cfg.every_min > 720) return "Interval must be 1 to 720 minutes.";
  if (!Number.isInteger(cfg.days) || cfg.days < 1 || cfg.days > 60) return "Days must be 1 to 60.";
  const duration = (end - start + 1440) % 1440 || 1440;
  if (cfg.every_min > duration) return "Interval is longer than the window.";
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, start);
  if (first.getTime() + duration * 60000 <= now.getTime()) first.setDate(first.getDate() + 1);
  const last = new Date(first);
  last.setDate(last.getDate() + cfg.days - 1);
  const stop = new Date(last.getTime() + duration * 60000);
  return { start_boundary: localIso(first), end_boundary: localIso(stop), every_min: cfg.every_min, duration_min: duration };
}

export const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface PeakPoint {
  ts: number;
  /** Ping average, or the destination's trace RTT when ping got no reply. */
  ms?: number;
  /** Hops up to the last one that answered. */
  hops: number;
}

export interface PeakPath {
  key: string[];
  /** The fullest sighting, for drawing and naming the path. */
  hops: Hop[];
  points: PeakPoint[];
  share: number;
  medianMs?: number;
  minMs?: number;
  medianHops?: number;
}

export interface PeakSummary {
  samples: number;
  failed: number;
  paths: PeakPath[];
  medianMs?: number;
  /** Lowest median among paths seen often enough to count. */
  best?: PeakPath;
  /** Overall median minus the best path's median. */
  gainMs?: number;
  from?: number;
  to?: number;
}

/** Below this gain a relay that forces the best path is not worth running. */
export const RELAY_WORTH_MS = 10;

export function pointOf(s: PeakSample, hops: Hop[]): PeakPoint {
  const dest = hops.find((h) => h.ip === s.target && h.avg != null);
  const lastAnswer = hops.filter((h) => h.avg != null).pop();
  return { ts: s.ts, ms: s.ping?.avg ?? dest?.avg ?? undefined, hops: lastAnswer?.hop ?? hops.length };
}

/**
 * Group samples by path. `located` gives each sample's hops with places filled in, and `keyOf`
 * the path key (networks and cities). Samples with no answering hop count as failed.
 */
export function summarize(samples: PeakSample[], located: (s: PeakSample) => Hop[], keyOf: (hops: Hop[]) => string[]): PeakSummary {
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  const paths: PeakPath[] = [];
  let failed = 0;
  const all: number[] = [];
  for (const s of sorted) {
    const hops = located(s);
    const key = hops.some((h) => h.avg != null) ? keyOf(hops) : [];
    if (!s.ok || !key.length) {
      failed++;
      continue;
    }
    const pt = pointOf(s, hops);
    if (pt.ms != null) all.push(pt.ms);
    const p = paths.find((x) => samePath(x.key, key));
    if (p) {
      p.points.push(pt);
      if (key.length > p.key.length) Object.assign(p, { key, hops });
    } else paths.push({ key, hops, points: [pt], share: 0 });
  }
  const ok = sorted.length - failed;
  for (const p of paths) {
    const ms = p.points.map((x) => x.ms).filter((v): v is number => v != null);
    p.share = ok ? p.points.length / ok : 0;
    p.medianMs = median(ms);
    p.minMs = ms.length ? Math.min(...ms) : undefined;
    p.medianHops = median(p.points.map((x) => x.hops));
  }
  // Most-used path first, so Path A is the usual one.
  paths.sort((a, b) => b.points.length - a.points.length);
  const medianMs = median(all);
  // A path seen once or twice may be a fluke, so the best needs at least 3 samples and 5% share.
  const counted = paths.filter((p) => p.medianMs != null && p.points.length >= Math.max(3, ok * 0.05));
  const best = counted.reduce<PeakPath | undefined>((b, p) => (!b || p.medianMs! < b.medianMs! ? p : b), undefined);
  return {
    samples: sorted.length,
    failed,
    paths,
    medianMs,
    best,
    gainMs: best && medianMs != null ? medianMs - best.medianMs! : undefined,
    from: sorted[0]?.ts,
    to: sorted[sorted.length - 1]?.ts,
  };
}

/** The decision the log supports, in one sentence. */
export function verdict(s: PeakSummary, name: (p: PeakPath) => string): string {
  if (!s.best || s.gainMs == null || s.medianMs == null) return "Not enough samples yet. The verdict appears once a path has 3 samples.";
  if (s.paths.length < 2) return `One path seen in ${s.samples} samples, median ${s.medianMs.toFixed(0)} ms. Route choice is stable, so a relay can only help if it is closer to the server than this path.`;
  if (s.gainMs >= RELAY_WORTH_MS)
    return `${name(s.best)} runs ${s.gainMs.toFixed(0)} ms under the median (${s.best.medianMs!.toFixed(0)} vs ${s.medianMs.toFixed(0)} ms). A Chicago relay that holds you on it is worth testing.`;
  return `The best path is only ${s.gainMs.toFixed(0)} ms under the median (${s.best.medianMs!.toFixed(0)} vs ${s.medianMs.toFixed(0)} ms). A relay is unlikely to beat the route you already get.`;
}
