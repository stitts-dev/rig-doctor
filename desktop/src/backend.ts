// One seam between the UI and the engine. Inside Tauri it forwards to the Rust
// commands and events. In a plain browser (vite dev without Tauri) it serves a
// replay of a real session, so the UI can be designed and checked without the app.

import type { CompareProgress, Config, Conn, DoneEvent, Geo, HopEvent, PeakHop, PeakSample, PeakStatus, PingStats, RdnsEvent, RelayComparison, RouteMeasure, TsPeer } from "./types";
import type { AutoResult, RelayStatus, RelaySummary } from "./relay";
import type { JudgedRecord } from "./proof";
import { replayAutoRecord, replayCompareRecord, replayHistory } from "./replay-proof";

type Handler<T> = (payload: T) => void;

export interface Backend {
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  on<T>(event: string, handler: Handler<T>): void;
  readonly mock: boolean;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriBackend(): Promise<Backend> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  return {
    mock: false,
    call: <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args),
    on: <T>(event: string, handler: Handler<T>) => {
      void listen<T>(event, (e) => handler(e.payload));
    },
  };
}

// ---------- replay session ----------
// Synthetic: a home near Columbus, OH on a made-up cable ISP (AS64500, documentation ASN).
// Every non-Riot address is a documentation address (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).

const RDNS: Record<string, string> = {
  "192.0.2.11": "po-57-rur301.hilliard.oh.cr.example-cable.net",
  "192.0.2.12": "po-2-rur302.hilliard.oh.cr.example-cable.net",
  "192.0.2.13": "po-300-xar02.hilliard.oh.cr.example-cable.net",
  "192.0.2.14": "be-53-ar01.columbus.oh.cr.example-cable.net",
  "192.0.2.21": "be-31621-cs02.dublin.oh.core.example-cable.net",
  "192.0.2.22": "be-31611-cs01.dublin.oh.core.example-cable.net",
  "192.0.2.31": "be-4112-pe12.ashburn.va.core.example-cable.net",
  "192.0.2.32": "be-2112-pe12.350ecermak.il.core.example-cable.net",
  "104.160.143.77": "ae1.er02.was01.riotdirect.net",
  "104.160.159.126": "ae3.er02.chi01.riotdirect.net",
  "203.0.113.42": "derp-example.tailscale.com",
  // Replay-only routers for the New York path below.
  "192.0.2.33": "be-1311-cs03.newyork.ny.core.example-cable.net",
  "192.0.2.34": "be-2311-pe11.111eighthave.ny.core.example-cable.net",
  "104.160.142.9": "ae2.er01.nyc01.riotdirect.net",
};

const CABLE = { as: "AS64500 Example Cable Communications, LLC", isp: "Example Cable Communications" };
const RIOT = { as: "AS6507 Riot Games, Inc", isp: "Riot Games" };
const GEO: Record<string, Partial<Geo>> = {
  self: { city: "Pataskala", regionName: "Ohio", country: "United States", lat: 39.971, lon: -82.669, isp: "Example Cable" },
  // Backbone routers: GeoIP knows the owner but puts them at the company HQ, so the replay gives no location.
  ...Object.fromEntries(Object.keys(RDNS).filter((ip) => ip.startsWith("192.0.2.")).map((ip) => [ip, CABLE])),
  "104.160.143.77": RIOT,
  "104.160.159.126": RIOT,
  "104.160.142.9": RIOT,
  "104.160.151.161": { city: "Chicago", regionName: "Illinois", lat: 41.878, lon: -87.63, ...RIOT },
  "104.160.151.134": { city: "Chicago", regionName: "Illinois", lat: 41.878, lon: -87.63, ...RIOT },
  "104.160.131.1": { city: "Chicago", regionName: "Illinois", lat: 41.878, lon: -87.63, ...RIOT },
  "104.160.131.3": { city: "Chicago", regionName: "Illinois", lat: 41.878, lon: -87.63, ...RIOT },
  "192.207.0.5": { city: "Chicago", regionName: "Illinois", lat: 41.878, lon: -87.63, ...RIOT },
  "203.0.113.43": { city: "Ashburn", regionName: "Virginia", lat: 39.044, lon: -77.488, isp: "Cloudflare", as: "AS13335 Cloudflare, Inc." },
  "203.0.113.44": { city: "Ashburn", regionName: "Virginia", lat: 39.044, lon: -77.488, isp: "Cloudflare", as: "AS13335 Cloudflare, Inc." },
  "203.0.113.40": { city: "Hillsboro", regionName: "Oregon", lat: 45.52, lon: -122.99, isp: "OVH", as: "AS16276 OVH SAS" },
  "203.0.113.41": { city: "Chicago", regionName: "Illinois", lat: 41.835, lon: -87.665, isp: "RackNerd" },
  "203.0.113.42": { city: "Chicago", regionName: "Illinois", lat: 41.853, lon: -87.618, isp: "Tailscale" },
};

type H = [string | null, (number | null)[]];
const CABLE_HEAD: H[] = [
  ["192.168.1.1", [5, 3, 3]],
  ["172.16.20.1", [13, 11, 8]],
  ["192.0.2.11", [22, 18, 17]],
  ["192.0.2.12", [16, 10, 17]],
  ["192.0.2.13", [10, 8, 17]],
  ["192.0.2.14", [23, 21, 16]],
];
const TRACES: Record<string, H[]> = {
  "192.207.0.5": [...CABLE_HEAD, ["192.0.2.21", [15, 17, 12]], ["192.0.2.31", [23, 26, 21]], [null, [null, null, null]], ["104.160.143.77", [86, 79, 76]], ["104.160.159.126", [84, 80, 75]], ["104.160.151.161", [80, 73, 80]], [null, [null, null, null]], [null, [null, null, null]]],
  "104.160.131.1": [...CABLE_HEAD, ["192.0.2.21", [17, 17, 16]], ["192.0.2.31", [18, 31, 26]], [null, [null, null, null]], ["104.160.143.77", [86, 79, 76]], ["104.160.159.126", [84, 80, 75]], ["104.160.151.161", [80, 73, 80]], ["104.160.151.134", [80, 80, 80]], ["104.160.131.1", [85, 80, 81]]],
  "203.0.113.42": [...CABLE_HEAD.slice(0, 5), ["192.0.2.22", [17, 17, 22]], ["192.0.2.32", [30, 23, 26]], [null, [null, null, null]], ["203.0.113.42", [31, 29, 25]]],
  "203.0.113.43": [...CABLE_HEAD, ["192.0.2.21", [16, 15, 17]], ["192.0.2.31", [19, 22, 20]], ["203.0.113.43", [21, 20, 22]]],
  "203.0.113.44": [...CABLE_HEAD, ["192.0.2.21", [16, 15, 17]], ["192.0.2.31", [19, 22, 20]], ["203.0.113.44", [22, 21, 21]]],
  "203.0.113.40": [...CABLE_HEAD, ["192.0.2.21", [16, 15, 17]], [null, [null, null, null]], ["203.0.113.40", [78, 80, 79]]],
  "203.0.113.41": [...CABLE_HEAD.slice(0, 5), ["192.0.2.22", [17, 18, 21]], ["192.0.2.32", [27, 24, 25]], [null, [null, null, null]], ["203.0.113.41", [29, 28, 28]]],
};

// Re-traces of the Riot routes cycle through Ashburn, Chicago and New York handoffs, so the replay
// shows how a route that changed between runs is listed. Built for the replay, not recorded.
const CHICAGO_PATH: H[] = [...CABLE_HEAD.slice(0, 5), ["192.0.2.22", [17, 19, 18]], ["192.0.2.32", [26, 24, 27]], ["104.160.159.126", [64, 61, 60]], ["104.160.151.161", [62, 61, 63]]];
const NEW_YORK_PATH: H[] = [...CABLE_HEAD, ["192.0.2.21", [16, 17, 15]], ["192.0.2.33", [24, 26, 25]], ["192.0.2.34", [27, 26, 28]], ["104.160.142.9", [29, 30, 28]], ["104.160.159.126", [91, 88, 90]], ["104.160.151.161", [92, 89, 90]]];
const ALT_TRACES: Record<string, H[][]> = {
  "192.207.0.5": [
    [...CHICAGO_PATH, [null, [null, null, null]], [null, [null, null, null]]],
    [...NEW_YORK_PATH, [null, [null, null, null]], [null, [null, null, null]]],
  ],
  "104.160.131.1": [
    [...CHICAGO_PATH, ["104.160.151.134", [62, 62, 61]], ["104.160.131.1", [63, 62, 64]]],
    [...NEW_YORK_PATH, ["104.160.151.134", [91, 90, 92]], ["104.160.131.1", [93, 91, 92]]],
  ],
};
// A short local route where GeoIP files two cable-ISP routers at regional offices in Cleveland and
// Nashville, close enough to pass the check against home but not against their neighbours. The two
// routers have no reverse DNS, so only GeoIP names a place. Documentation addresses, not real hosts.
const MISPLACED = "198.51.100.30";
GEO["198.51.100.31"] = { city: "Cleveland", regionName: "Ohio", country: "United States", lat: 41.499, lon: -81.694, ...CABLE };
GEO["198.51.100.32"] = { city: "Nashville", regionName: "Tennessee", country: "United States", lat: 36.162, lon: -86.781, ...CABLE };
GEO[MISPLACED] = { city: "Dublin", regionName: "Ohio", country: "United States", lat: 40.111, lon: -83.126, isp: "Cloudflare", as: "AS13335 Cloudflare, Inc." };
TRACES[MISPLACED] = [
  ["192.168.1.1", [5, 3, 3]],
  ["172.16.20.1", [13, 11, 8]],
  ["192.0.2.11", [22, 18, 17]],
  ["198.51.100.31", [16, 15, 17]],
  ["192.0.2.13", [10, 8, 17]],
  ["198.51.100.32", [23, 21, 16]],
  ["192.0.2.21", [15, 16, 17]],
  [MISPLACED, [18, 18, 19]],
];

const runs = new Map<string, number>();

// A week of peak-hour samples to the Riot NA ping address, 18:00 to 24:00 every 10 minutes from
// 31 Oct 2026. Built for the replay from the three paths above, with evening congestion on the
// Ashburn handoff. Not recorded.
function peakReplay(): PeakSample[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const NA = "104.160.131.3";
  const toNa = (hs: H[]): H[] => hs.map(([ip, r]) => [ip === "104.160.131.1" ? NA : ip, r]);
  const paths = [toNa(TRACES["104.160.131.1"]), ...ALT_TRACES["104.160.131.1"].map(toNa)];
  const out: PeakSample[] = [];
  for (let day = 0; day < 7; day++) {
    for (let slot = 0; slot < 36; slot++) {
      const t = new Date(2026, 9, 31 + day, 18, slot * 10, Math.floor(rnd() * 20));
      const r = rnd();
      // Ashburn most evenings, Chicago on about a quarter of runs, New York now and then.
      const which = r < 0.6 ? 0 : r < 0.86 ? 1 : 2;
      // Load peaks around 21:00.
      const busy = Math.max(0, 1 - Math.abs(slot - 18) / 12);
      const extra = (which === 1 ? 2 : 9) * busy + rnd() * 4;
      if (rnd() < 0.015) {
        out.push({ ts: t.getTime(), target: NA, hops: [], ping: null, ok: false, error: "Request timed out." });
        continue;
      }
      const hops = paths[which].map(([ip, rtts], i) => {
        const shifted = rtts.map((v) => (v == null ? null : Math.round(v + (i > 5 ? extra : rnd() * 2))));
        const good = shifted.filter((v): v is number => v != null);
        return { hop: i + 1, ip, rtts: shifted, avg: good.length ? good.reduce((a, b) => a + b, 0) / good.length : null, rdns: ip ? RDNS[ip] : undefined };
      });
      const dest = hops[hops.length - 1].avg!;
      const avg = Math.round((dest - 2 + rnd() * 2) * 10) / 10;
      out.push({ ts: t.getTime(), target: NA, hops, ok: true, ping: { host: NA, sent: 10, received: 10, min: avg - 2, avg, max: avg + 4, p95: avg + 3, jitter: 1.4 } });
    }
  }
  return out;
}

const CONNS: Conn[] = [
  { pid: 41200, process: "League of Legends", proto: "udp", local: "192.168.1.50:51234", remote_ip: "192.207.0.5", remote_port: 7330, state: "" },
  { pid: 35364, process: "LeagueClient", proto: "tcp", local: "192.168.1.50:51800", remote_ip: "104.160.131.1", remote_port: 443, state: "ESTABLISHED" },
  { pid: 25960, process: "ExitLag", proto: "tcp", local: "192.168.1.50:52001", remote_ip: "203.0.113.40", remote_port: 443, state: "ESTABLISHED" },
  { pid: 7124, process: "chrome", proto: "tcp", local: "192.168.1.50:52310", remote_ip: "203.0.113.43", remote_port: 443, state: "ESTABLISHED" },
  { pid: 7124, process: "chrome", proto: "tcp", local: "192.168.1.50:52311", remote_ip: "203.0.113.43", remote_port: 443, state: "ESTABLISHED" },
  { pid: 9012, process: "Discord", proto: "tcp", local: "192.168.1.50:52400", remote_ip: "203.0.113.44", remote_port: 443, state: "ESTABLISHED" },
  { pid: 6620, process: "Spotify", proto: "tcp", local: "192.168.1.50:52500", remote_ip: MISPLACED, remote_port: 443, state: "ESTABLISHED" },
  { pid: 3300, process: "tailscaled", proto: "udp", local: "192.168.1.50:41641", remote_ip: "203.0.113.42", remote_port: 3478, state: "" },
];

// ---------- relay proof replay ----------
// Three relay_compare results for the Riot NA ping address, served in turn: a gain, no gain, and a
// tunnel that is down. Built for the replay, not recorded. The relay is a documentation address.
const PROOF_RELAY = "203.0.113.10";
GEO[PROOF_RELAY] = { city: "Chicago", regionName: "Illinois", country: "United States", lat: 41.85, lon: -87.65, isp: "Vultr", as: "AS20473 The Constant Company, LLC" };

function proofMeasure(base: number, spread: number, lossEvery: number, path: H[], seed: number, n: number): RouteMeasure {
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rtts = Array.from({ length: n }, (_, i) => (lossEvery && i % lossEvery === lossEvery - 1 ? null : Math.round((base + (rnd() - 0.3) * spread) * 10) / 10));
  const got = rtts.filter((v): v is number => v != null).sort((a, b) => a - b);
  const q = (f: number) => got[Math.min(got.length - 1, Math.round((got.length - 1) * f))] ?? null;
  const hops: PeakHop[] = path.map(([ip, r], i) => {
    const good = r.filter((v): v is number => v != null);
    return { hop: i + 1, ip, rtts: r, avg: good.length ? good.reduce((a, b) => a + b, 0) / good.length : null, rdns: ip ? RDNS[ip] : undefined };
  });
  return { sent: n, received: got.length, rtts, min: got[0] ?? null, median: q(0.5), p90: q(0.9), jitter: null, hops };
}

/** A week of earlier comparisons, one or two an evening, so the history list has something to show. */
function proofHistoryReplay(): JudgedRecord[] {
  const out: JudgedRecord[] = [];
  const now = Date.now();
  // Mostly gains, one evening already on the Chicago handoff, one night the tunnel failed.
  const runs = [0, 0, 1, 0, 0, 2, 0, 0, 1, 0];
  runs.forEach((run, i) => {
    const c = proofReplay(run, "104.160.131.3", 50, 40 + i * 7);
    c.finished_at = now - (6 - Math.floor(i * 0.65)) * 86400000 - (3 + (i % 2) * 2) * 3600000;
    out.push(replayCompareRecord(c));
  });
  return out.sort((a, b) => a.record.ts - b.record.ts);
}

function proofReplay(run: number, target: string, n: number, seed = 0): RelayComparison {
  const direct = TRACES["104.160.131.1"].map(([ip, r]): H => [ip === "104.160.131.1" ? target : ip, r]);
  const viaRelay: H[] = [["10.66.66.1", [27, 26, 28]], ["104.160.159.126", [29, 28, 30]], ["104.160.151.161", [30, 29, 30]], ["104.160.151.134", [30, 31, 30]], [target, [31, 30, 31]]];
  const started = Date.now() - 2 * n * 1000;
  const base = { target, relay_host: PROOF_RELAY, started_at: started, finished_at: Date.now(), error: null };
  switch (run % 3) {
    case 0:
      return { ...base, direct: proofMeasure(79, 9, 25, direct, 3 + seed, n), relay: proofMeasure(30.5, 3, 0, viaRelay, 5 + seed, n) };
    case 1: {
      // An evening where the direct route already takes the Chicago handoff.
      const good = CHICAGO_PATH.map(([ip, r]): H => [ip, ip?.startsWith("104.160.") ? r.map((v) => (v == null ? v : v - 33)) : r]).concat([["104.160.151.134", [31, 31, 30]], [target, [32, 31, 32]]] as H[]);
      return { ...base, direct: proofMeasure(31, 3, 0, good, 9 + seed, n), relay: proofMeasure(31.6, 3, 0, viaRelay, 11 + seed, n) };
    }
    default:
      return { ...base, direct: proofMeasure(80, 8, 0, direct, 13 + seed, n), relay: null, error: "The relay tunnel did not come up: no handshake from the relay in 10 s." };
  }
}

const PING: Record<string, number> = { "203.0.113.41": 28.3, "203.0.113.42": 27.1, "203.0.113.40": 79 };

// Relay tunnel replay: a config naming a documentation address, never a real relay.
const RELAY_CONF: RelaySummary = { name: "relay-chi-1", endpoint: "203.0.113.10:51820", address: "10.66.66.2/32", peer_key: "cGxhY2Vo", allowed_ips: 42, probe: "10.66.66.1", keepalive: 25 };

function mockBackend(): Backend {
  let relayConf: RelaySummary | null = null;
  let relayFailUp = false;
  const relay: RelayStatus = { installed: true, imported: false, name: null, saved: 0, state: "down", endpoint: null, handshake_age_s: null, rx_bytes: null, tx_bytes: null, probe_ms: null, detail: null };
  const handlers = new Map<string, Handler<unknown>[]>();
  const emit = (event: string, payload: unknown) => (handlers.get(event) ?? []).forEach((h) => h(payload));
  let peak: PeakSample[] | undefined;
  let peakScheduled = false;
  let proofRuns = 0;
  let proofLog: JudgedRecord[] | undefined;
  let config: Config = { relays: [{ name: "Chicago VPS (RackNerd)", host: "203.0.113.41" }, { name: "Tailscale DERP Chicago", host: "203.0.113.42" }], focus: "League of Legends" };
  const geoOf = (q: string): Geo => {
    const g = GEO[q];
    return g ? { query: q, status: "success", ...g } : { query: q, status: "fail" };
  };
  return {
    mock: true,
    on: <T>(event: string, handler: Handler<T>) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler as Handler<unknown>]);
    },
    async call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      switch (cmd) {
        case "list_connections":
          return CONNS as unknown as T;
        case "read_config":
          return structuredClone(config) as T;
        case "write_config":
          config = structuredClone(args.config as Config);
          return undefined as T;
        case "geolocate":
          return (args.ips as string[]).map(geoOf) as T;
        case "ping_stats": {
          const avg = PING[args.host as string] ?? null;
          return { host: args.host, sent: 10, received: avg == null ? 0 : 10, min: avg, avg, max: avg, p95: avg, jitter: avg == null ? null : 2.1 } as PingStats as T;
        }
        case "peak_log":
          return (peak ??= peakReplay()) as T;
        case "peak_status":
          return { scheduled: peakScheduled, log_path: "replay", samples: (peak ??= peakReplay()).length } as PeakStatus as T;
        case "peak_schedule":
          peakScheduled = true;
          return undefined as T;
        case "peak_unschedule":
          peakScheduled = false;
          return undefined as T;
        case "peak_sample_now": {
          const last = (peak ??= peakReplay()).filter((x) => x.ok).pop()!;
          const s = { ...structuredClone(last), ts: Date.now() };
          peak.push(s);
          return s as T;
        }
        case "proof_history":
          return structuredClone(replayHistory((proofLog ??= proofHistoryReplay()), Date.now())) as T;
        case "relay_compare": {
          const n = Math.max(1, Math.min(500, Number(args.pings ?? 50)));
          const run = proofRuns++;
          // Replays the progress events at 20 pings a second per phase.
          for (const phase of ["direct", "relay"] as const)
            for (let done = 1; done <= n; done++) setTimeout(() => emit("compare:progress", { phase, done, total: n } as CompareProgress), (phase === "relay" ? n : 0) * 50 + done * 50);
          await new Promise((r) => setTimeout(r, 2 * n * 50 + 150));
          const c = proofReplay(run, args.target as string, n);
          c.record = replayCompareRecord(c);
          (proofLog ??= proofHistoryReplay()).push(c.record);
          return c as T;
        }
        case "route_auto": {
          // Replays a run that picks the relay: 10 rounds over the given targets, direct then relay.
          const targets = [...new Set([...((args.targets as string[]) ?? []), "104.160.131.20", "104.160.131.1", "104.160.130.3", "104.160.130.10"])].filter((t) => t !== "192.207.0.5");
          const total = 10 * targets.length;
          for (const [k, phase] of ["direct", relayConf?.name ?? "relay-1"].entries()) for (let done = 1; done <= total; done++) setTimeout(() => emit("auto:progress", { phase, done, total }), (k * total + done) * 25);
          await new Promise((r) => setTimeout(r, 2 * total * 25 + 150));
          const started = Date.now() - 2 * total * 25;
          // Per host: the relay wins on the given game server and on most Riot probes.
          const hostsFor = (medians: number[]) => targets.map((target, i) => { const m = medians[Math.min(i, medians.length - 1)]; return { target, score: { sent: 10, received: 10, loss: 0, median: m, p95_jitter: 1, score: m + 0.5, eligible: true } }; });
          // Like the backend: the given game server counts only when it answers ping (is a target).
          const given = (args.targets as string[] | undefined)?.[0];
          const live = given && targets.includes(given) ? given : null;
          const paths = relayConf
            ? [
                { candidate: { id: relayConf!.name ?? "relay-1", kind: "relay", label: relayConf!.name ?? "relay-1", endpoint: "203.0.113.10" }, score: { sent: total, received: total, loss: 0, median: 30.5, p95_jitter: 2.4, score: 31.7, eligible: true }, hosts: hostsFor([30, 42, 30, 31, 30]), floor_ms: 26.1, note: null },
                { candidate: { id: "direct", kind: "direct", label: "Direct", endpoint: null }, score: { sent: total, received: total - 1, loss: 1 / total, median: 79, p95_jitter: 9.8, score: 79 + 4.9 + 300 / total, eligible: true }, hosts: hostsFor([79, 25, 76, 76, 79]), floor_ms: null, note: null },
              ]
            : [{ candidate: { id: "direct", kind: "direct", label: "Direct", endpoint: null }, score: { sent: total, received: total, loss: 0, median: 79, p95_jitter: 9.8, score: 83.9, eligible: true }, hosts: hostsFor([79, 25, 76, 76, 79]), floor_ms: null, note: null }];
          const pick = relayConf
            ? live
              ? { id: relayConf.name ?? "relay-1", gain_ms: 49, reason: `On the game server ${live}, ${relayConf.name ?? "relay-1"} scores 49 ms better than direct.`, live, vs: relayConf.name ?? "relay-1" }
              : { id: relayConf.name ?? "relay-1", gain_ms: 45.5, reason: `${relayConf.name ?? "relay-1"} is 10 ms or more better on 3 of 4 hosts.`, live: null, vs: relayConf.name ?? "relay-1" }
            : { id: "direct", gain_ms: null, reason: "No relay to compare. Direct is the only path.", live: null, vs: null };
          const switches = relayConf && relay.state !== "up" ? 1 : 0;
          if (relayConf) {
            relay.state = "up";
            relay.handshake_age_s = 4;
          }
          const a = { targets, live, paths, pick, min_gain_ms: 10, switches, applied: true, started_at: started, finished_at: Date.now(), error: null } as unknown as AutoResult;
          a.record = replayAutoRecord(a);
          if (a.record) (proofLog ??= proofHistoryReplay()).push(a.record);
          return a as T;
        }
        case "route_check":
          return { path: relay.state === "up" ? relayConf?.name ?? "relay-1" : "direct", score: { sent: 20, received: 20, loss: 0, median: 31, p95_jitter: 2, score: 32, eligible: true }, recheck: (args.ageS as number) >= 600 ? `Last full check was ${Math.floor((args.ageS as number) / 60)} min ago.` : null } as T;
        case "relay_status":
          return { ...relay, endpoint: relayConf ? relayConf.endpoint : null, name: relayConf ? relayConf.name : null, saved: relayConf ? 1 : 0 } as T;
        case "relay_list":
          return (relayConf ? [{ ...relayConf, active: true }] : []) as T;
        case "relay_config":
          return relayConf as T;
        case "relay_import":
          if (!/\[Peer\]/i.test(String(args.text))) throw new Error("Config needs exactly one [Interface] and one [Peer] (found 0 and 0).");
          relayConf = { ...RELAY_CONF };
          relayFailUp = String(args.text).includes("# fail-up");
          relay.imported = true;
          return relayConf as T;
        case "relay_remove":
          relayConf = null;
          relay.imported = false;
          return undefined as T;
        case "relay_up":
        case "relay_down":
          if (cmd === "relay_up" && !relayConf) throw new Error("Import a relay config first.");
          // A config with "# fail-up" replays a start that times out, to check Off still works.
          if (cmd === "relay_up" && relayFailUp) throw new Error("The tunnel did not come up within 15 s. Press Off to clear anything it left behind.");
          relay.state = cmd === "relay_up" ? "up" : "down";
          relay.handshake_age_s = relay.state === "up" ? 4 : null;
          return { ...relay, endpoint: relayConf?.endpoint ?? null } as T;
        case "relay_ping":
          if (relay.state !== "up") throw new Error("The relay is off. Turn it on to measure it.");
          return { host: "10.66.66.1", sent: 10, received: 10, min: 26.1, avg: 27.4, max: 29.8, p95: 29.8, jitter: 1.1 } as PingStats as T;
        case "tailscale_peers":
          return [] as TsPeer[] as T;
        case "trace": {
          const id = args.id as string;
          const target = args.target as string;
          const run = runs.get(target) ?? 0;
          runs.set(target, run + 1);
          const alts = ALT_TRACES[target];
          const hops = (alts && run % (alts.length + 1) && alts[(run % (alts.length + 1)) - 1]) || TRACES[target] || [[null, [null, null, null]]];
          hops.forEach(([ip, rtts], i) => {
            setTimeout(() => {
              const good = rtts.filter((v): v is number => v != null);
              const ev: HopEvent = { id, hop: i + 1, ip, rtts, avg: good.length ? good.reduce((a, b) => a + b, 0) / good.length : null };
              emit("trace:hop", ev);
              if (ip && RDNS[ip]) setTimeout(() => emit("trace:rdns", { id, hop: i + 1, ip, name: RDNS[ip] } as RdnsEvent), 120);
              if (i === hops.length - 1) setTimeout(() => emit("trace:done", { id, ok: true, error: null } as DoneEvent), 300);
            }, 180 * (i + 1));
          });
          return undefined as T;
        }
        default:
          throw new Error(`mock: unknown command ${cmd}`);
      }
    },
  };
}

export async function createBackend(): Promise<Backend> {
  return inTauri ? tauriBackend() : mockBackend();
}
