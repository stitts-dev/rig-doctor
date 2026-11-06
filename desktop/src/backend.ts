// One seam between the UI and the engine. Inside Tauri it forwards to the Rust
// commands and events. In a plain browser (vite dev without Tauri) it serves a
// replay of a real session, so the UI can be designed and checked without the app.

import type { Config, Conn, DoneEvent, Geo, HopEvent, PingStats, RdnsEvent, TsPeer } from "./types";

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

// ---------- replay of the 5 Nov 2026 session from Greensburg, PA ----------

const RDNS: Record<string, string> = {
  "96.110.213.121": "po-57-rur301.bethelpark.pa.pitt.comcast.net",
  "96.216.140.182": "po-2-rur302.bethelpark.pa.pitt.comcast.net",
  "96.110.2.173": "po-300-xar02.bethelpark.pa.pitt.comcast.net",
  "96.216.140.105": "be-53-ar01.mckeesport.pa.pitt.comcast.net",
  "96.110.42.165": "be-31621-cs02.pittsburgh.pa.ibone.comcast.net",
  "96.110.42.161": "be-31611-cs01.pittsburgh.pa.ibone.comcast.net",
  "96.110.37.98": "be-4112-pe12.ashburn.va.ibone.comcast.net",
  "96.110.33.210": "be-2112-pe12.350ecermak.il.ibone.comcast.net",
  "104.160.143.77": "ae1.er02.was01.riotdirect.net",
  "104.160.159.126": "ae3.er02.chi01.riotdirect.net",
  "209.177.158.246": "derp12d.tailscale.com",
  // Replay-only routers for the New York path below.
  "96.110.40.17": "be-1311-cs03.newyork.ny.ibone.comcast.net",
  "96.110.34.22": "be-2311-pe11.111eighthave.ny.ibone.comcast.net",
  "104.160.142.9": "ae2.er01.nyc01.riotdirect.net",
};

const COMCAST = { as: "AS7922 Comcast Cable Communications, LLC", isp: "Comcast Cable Communications" };
const RIOT = { as: "AS6507 Riot Games, Inc", isp: "Riot Games" };
const GEO: Record<string, Partial<Geo>> = {
  self: { city: "Greensburg", regionName: "Pennsylvania", country: "United States", lat: 40.301, lon: -79.539, isp: "Comcast Cable" },
  // Backbone routers: GeoIP knows the owner but puts them at the company HQ, so the replay gives no location.
  ...Object.fromEntries(Object.keys(RDNS).filter((ip) => ip.startsWith("96.")).map((ip) => [ip, COMCAST])),
  "104.160.143.77": RIOT,
  "104.160.159.126": RIOT,
  "104.160.142.9": RIOT,
  "104.160.151.161": { city: "Chicago", regionName: "Illinois", lat: 41.878, lon: -87.63, ...RIOT },
  "104.160.151.134": { city: "Chicago", regionName: "Illinois", lat: 41.878, lon: -87.63, ...RIOT },
  "104.160.131.1": { city: "Chicago", regionName: "Illinois", lat: 41.878, lon: -87.63, ...RIOT },
  "192.207.0.5": { city: "Chicago", regionName: "Illinois", lat: 41.878, lon: -87.63, ...RIOT },
  "104.16.120.50": { city: "Ashburn", regionName: "Virginia", lat: 39.044, lon: -77.488, isp: "Cloudflare", as: "AS13335 Cloudflare, Inc." },
  "162.159.128.233": { city: "Ashburn", regionName: "Virginia", lat: 39.044, lon: -77.488, isp: "Cloudflare", as: "AS13335 Cloudflare, Inc." },
  "15.235.53.110": { city: "Hillsboro", regionName: "Oregon", lat: 45.52, lon: -122.99, isp: "OVH", as: "AS16276 OVH SAS" },
  "198.23.228.15": { city: "Chicago", regionName: "Illinois", lat: 41.835, lon: -87.665, isp: "RackNerd" },
  "209.177.158.246": { city: "Chicago", regionName: "Illinois", lat: 41.853, lon: -87.618, isp: "Tailscale" },
};

type H = [string | null, (number | null)[]];
const COMCAST_HEAD: H[] = [
  ["10.0.0.1", [5, 3, 3]],
  ["172.20.48.186", [13, 11, 8]],
  ["96.110.213.121", [22, 18, 17]],
  ["96.216.140.182", [16, 10, 17]],
  ["96.110.2.173", [10, 8, 17]],
  ["96.216.140.105", [23, 21, 16]],
];
const TRACES: Record<string, H[]> = {
  "192.207.0.5": [...COMCAST_HEAD, ["96.110.42.165", [15, 17, 12]], ["96.110.37.98", [23, 26, 21]], [null, [null, null, null]], ["104.160.143.77", [86, 79, 76]], ["104.160.159.126", [84, 80, 75]], ["104.160.151.161", [80, 73, 80]], [null, [null, null, null]], [null, [null, null, null]]],
  "104.160.131.1": [...COMCAST_HEAD, ["96.110.42.165", [17, 17, 16]], ["96.110.37.98", [18, 31, 26]], [null, [null, null, null]], ["104.160.143.77", [86, 79, 76]], ["104.160.159.126", [84, 80, 75]], ["104.160.151.161", [80, 73, 80]], ["104.160.151.134", [80, 80, 80]], ["104.160.131.1", [85, 80, 81]]],
  "209.177.158.246": [...COMCAST_HEAD.slice(0, 5), ["96.110.42.161", [17, 17, 22]], ["96.110.33.210", [30, 23, 26]], [null, [null, null, null]], ["209.177.158.246", [31, 29, 25]]],
  "104.16.120.50": [...COMCAST_HEAD, ["96.110.42.165", [16, 15, 17]], ["96.110.37.98", [19, 22, 20]], ["104.16.120.50", [21, 20, 22]]],
  "162.159.128.233": [...COMCAST_HEAD, ["96.110.42.165", [16, 15, 17]], ["96.110.37.98", [19, 22, 20]], ["162.159.128.233", [22, 21, 21]]],
  "15.235.53.110": [...COMCAST_HEAD, ["96.110.42.165", [16, 15, 17]], [null, [null, null, null]], ["15.235.53.110", [78, 80, 79]]],
  "198.23.228.15": [...COMCAST_HEAD.slice(0, 5), ["96.110.42.161", [17, 18, 21]], ["96.110.33.210", [27, 24, 25]], [null, [null, null, null]], ["198.23.228.15", [29, 28, 28]]],
};

// Re-traces of the Riot routes cycle through Ashburn, Chicago and New York handoffs, so the replay
// shows how a route that changed between runs is listed. Built for the replay, not recorded.
const CHICAGO_PATH: H[] = [...COMCAST_HEAD.slice(0, 5), ["96.110.42.161", [17, 19, 18]], ["96.110.33.210", [26, 24, 27]], ["104.160.159.126", [64, 61, 60]], ["104.160.151.161", [62, 61, 63]]];
const NEW_YORK_PATH: H[] = [...COMCAST_HEAD, ["96.110.42.165", [16, 17, 15]], ["96.110.40.17", [24, 26, 25]], ["96.110.34.22", [27, 26, 28]], ["104.160.142.9", [29, 30, 28]], ["104.160.159.126", [91, 88, 90]], ["104.160.151.161", [92, 89, 90]]];
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
const runs = new Map<string, number>();

const CONNS: Conn[] = [
  { pid: 41200, process: "League of Legends", proto: "udp", local: "10.0.0.106:51234", remote_ip: "192.207.0.5", remote_port: 7330, state: "" },
  { pid: 35364, process: "LeagueClient", proto: "tcp", local: "10.0.0.106:51800", remote_ip: "104.160.131.1", remote_port: 443, state: "ESTABLISHED" },
  { pid: 25960, process: "ExitLag", proto: "tcp", local: "10.0.0.106:52001", remote_ip: "15.235.53.110", remote_port: 443, state: "ESTABLISHED" },
  { pid: 7124, process: "chrome", proto: "tcp", local: "10.0.0.106:52310", remote_ip: "104.16.120.50", remote_port: 443, state: "ESTABLISHED" },
  { pid: 7124, process: "chrome", proto: "tcp", local: "10.0.0.106:52311", remote_ip: "104.16.120.50", remote_port: 443, state: "ESTABLISHED" },
  { pid: 9012, process: "Discord", proto: "tcp", local: "10.0.0.106:52400", remote_ip: "162.159.128.233", remote_port: 443, state: "ESTABLISHED" },
  { pid: 3300, process: "tailscaled", proto: "udp", local: "10.0.0.106:41641", remote_ip: "209.177.158.246", remote_port: 3478, state: "" },
];

const PING: Record<string, number> = { "198.23.228.15": 28.3, "209.177.158.246": 27.1, "15.235.53.110": 79 };

function mockBackend(): Backend {
  const handlers = new Map<string, Handler<unknown>[]>();
  const emit = (event: string, payload: unknown) => (handlers.get(event) ?? []).forEach((h) => h(payload));
  let config: Config = { relays: [{ name: "Chicago VPS (RackNerd)", host: "198.23.228.15" }, { name: "Tailscale DERP Chicago", host: "209.177.158.246" }], focus: "League of Legends" };
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
