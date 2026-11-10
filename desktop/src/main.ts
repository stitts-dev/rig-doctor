import { createBackend, type Backend } from "./backend";
import { mountBilling, type BillingUi } from "./billing";
import { mountDock } from "./dock";
import { DEFAULT_GAME, isGameProcess, mountRelay, type RelayStatus, type RelayUi } from "./relay";
import { RouteGlobe, type ArcDatum, type LabelWant, type LanePulse, type NodeKind, type PointDatum, type RaceLane, type RaceRun, type Territory } from "./globe";
import { estimateLegMs, fitsNeighbours, haversineKm, isPrivateIp, placeFromRdns, plausibleForRtt, REALISTIC, type Anchor } from "./geo";
import { biggestJump, floorRtts, town, netChain, networkOf, pathKey, samePath, segments, viaCities, type Segment } from "./route";
import { DEFAULT_PEAK, planSchedule, RELAY_WORTH_MS, summarize, verdict, type PeakPath, type PeakPoint, type PeakSummary } from "./peak";
import { stampsOf, type Passport } from "./passport";
import { cardText, cellValue, layout, lit, netName, type GainCell, type GainMap } from "./gainmap";
import { countryCentres } from "./regions";
import { RELAY_NET, routeStats, unstore, type Death, type HistorySummary, type JudgedRecord, type LiveMatch, type MatchPing, type MatchRace, type MatchSeries, type MonthVerdict, type NetSample, type ProofHistory, type ProofVerdict, type RouteStats } from "./proof";
import type { CompareProgress, Conn, Config, Dest, DoneEvent, GainView, Geo, Hop, HopEvent, PeakConfig, PeakSample, PeakStatus, PingStats, RdnsEvent, Relay, RelayComparison, RelayMeasure, RouteVariant, Trace } from "./types";

// ---------- state ----------

const state = {
  /** League's own ping for the last finished match, shown as the top bar's readout. */
  lastMatch: null as MatchPing | null,
  /** Remote addresses already sent for GeoIP, so each live connection is located once. */
  connGeoAsked: new Set<string>(),
  /** Process under the pointer in the list: its live connection arcs light up on the globe. */
  hoverProc: null as string | null,
  conns: [] as Conn[],
  procs: new Map<string, Conn[]>(),
  selectedProc: null as string | null,
  dests: new Map<string, Dest>(),
  selectedDest: null as string | null,
  traces: new Map<string, Trace>(), // key: destination ip
  /** Traces to each relay, so a relay route shows the measured path to it. Key: "relay:" + host. */
  relayTraces: new Map<string, Trace>(),
  /** Background re-traces of a destination, so a path that changes over time is listed. Key: "sample:" + ip. */
  sampleTraces: new Map<string, Trace>(),
  /** Per destination ip: background runs finished, and the timer of the next one. */
  sampling: new Map<string, { runs: number; timer?: ReturnType<typeof setTimeout> }>(),
  /** Index into the selected trace's variants to draw beside the current path. */
  selectedVariant: null as number | null,
  geo: new Map<string, Geo>(),
  home: null as { lat: number; lng: number; label: string } | null,
  config: { relays: [] } as Config,
  relayMeasures: new Map<string, RelayMeasure>(),
  /** WireGuard relays saved in the Relay section, shown beside the config relays. */
  tunnelRelays: [] as Relay[],
  /** The tunnel's relay and whether it is on, from the Relay section. */
  tunnel: undefined as RelayStatus | undefined,
  selectedRelay: null as string | null,
  inflight: 0,
  /** Trace ids waiting to run: a destination ip, or "relay:" + host. */
  queue: [] as string[],
  filter: "",
  lastRefresh: 0,
  /** Destination ip to frame once its trace finishes. */
  pendingFit: null as string | null,
  /** Peak-hour log view: samples from disk, their summary, and the path drawn on the globe. */
  peak: {
    open: false,
    samples: [] as PeakSample[],
    located: new Map<number, Hop[]>(),
    summary: undefined as PeakSummary | undefined,
    status: undefined as PeakStatus | undefined,
    selected: null as number | null,
    error: undefined as string | undefined,
  },
  /** Relay proof view: the last direct-vs-relay comparison and both routes located for the globe. */
  proof: {
    open: false,
    running: false,
    progress: undefined as CompareProgress | undefined,
    result: undefined as RelayComparison | undefined,
    direct: [] as Hop[],
    relay: [] as Hop[],
    /** Where the relay sits, from GeoIP of relay_host. */
    at: undefined as { lat: number; lng: number; name: string } | undefined,
    error: undefined as string | undefined,
    /** Every saved run with the backend's verdict, oldest first. */
    log: [] as JudgedRecord[],
    /** The refund rule per local month, newest first, from the backend. */
    months: [] as MonthVerdict[],
    /** The last 30 days, from the backend. */
    recent: undefined as HistorySummary | undefined,
    /** History row shown in the table; null shows the latest run. */
    viewing: null as number | null,
    /** Whether the log has been read once, so an empty log is not mistaken for one still loading. */
    loaded: false,
    /** The backend has a proof log it could not read, so no verdict can be shown. */
    logError: false,
  },
  /** Match race view: the direct and relay lanes to the game servers, from the backend's match_race. */
  passport: {
    open: false,
    data: undefined as Passport | undefined,
  },
  /** ISP gain map: the relay's gain table by region. `data` null: no relay joined with an invite. */
  gainMap: {
    open: false,
    data: undefined as GainMap | null | undefined,
    error: undefined as string | undefined,
  },
  race: {
    open: false,
    data: undefined as MatchRace | undefined,
    /** The match running now, from match_live, when it was read, and the tunnel's byte rate between the last two reads. */
    live: undefined as LiveMatch | undefined,
    liveAt: 0,
    rate: undefined as { rx: number; tx: number } | undefined,
    /** Live matches the view already opened for, so closing it mid-match keeps it closed. */
    opened: new Set<string>(),
    /** The replay: the match log it picks from, which of those is open (null: no replay), its lines once read, the line the cursor is on. */
    log: [] as MatchPing[],
    replayOf: null as number | null,
    replay: undefined as MatchSeries | undefined,
    at: 0,
    playing: false,
    /** Why the replay has nothing to show. */
    error: undefined as string | undefined,
  },
};

const MAX_CONCURRENT_TRACES = 3;
/** Distinct paths kept per destination. */
const MAX_VARIANTS = 6;
const RELAY = "relay:";
const SAMPLE = "sample:";
/** Background re-traces per destination, and the gap between them. Routes shift between runs as load is balanced. */
const SAMPLE_RUNS = 4;
const SAMPLE_GAP_MS = 15000;
/** Finished traces kept after their connection closes, so a brief reconnect does not re-trace. */
const MAX_STALE_TRACES = 20;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let api: Backend;

const globe = new RouteGlobe($("globe"));

// Well-known ports, so a destination row says what it is for.
const SERVICE: Record<number, string> = { 443: "tls", 80: "http", 53: "dns", 853: "dns", 123: "ntp", 3478: "stun", 5223: "push", 5222: "xmpp", 2099: "chat", 7330: "game", 8393: "riot", 8394: "riot", 41641: "wireguard", 51820: "wireguard", 1194: "vpn", 27015: "steam", 27036: "steam", 3074: "xbox", 1935: "rtmp", 5060: "sip", 22: "ssh", 25: "smtp", 993: "imap" };
function service(port: number): string | undefined {
  if (SERVICE[port]) return SERVICE[port];
  if (port >= 27015 && port <= 27050) return "steam";
  if (port >= 7000 && port <= 7999) return "game";
  if (port >= 8080 && port <= 8099) return "http";
  return undefined;
}

function idleStatus(): string {
  return `monitoring ${state.conns.length} connections${api?.mock ? " · replay data" : ""}`;
}

/** Header chip: the path game traffic takes now, so the connection count is never read as relay state. */
function renderPathChip(): void {
  const t = state.tunnel;
  const chip = $("pathChip");
  const on = t?.state === "up";
  chip.textContent = !t ? "Game traffic · checking" : on ? `Game traffic · via ${t.name ?? "relay"}` : t.state === "down" ? "Game traffic · direct" : `Relay ${t.state === "degraded" ? "partly on" : t.state}`;
  chip.classList.toggle("on", on);
  chip.title = on ? "Your game traffic goes through this relay. Turn it off in the Relay section or the Relays list." : "Your game traffic goes straight to the game server. Connect a relay in the Relays list or pick Auto in the Relay section.";
  const m = state.lastMatch;
  const ms = $("pathMs");
  ms.hidden = !m;
  if (m) {
    ms.innerHTML = `${Math.round(m.median_ms)}<small>ms</small>`;
    const via = m.path === "direct" ? "direct" : m.path === "unknown" ? "path unknown" : m.path === "mixed" ? "relay switched mid-match" : `via ${m.path}`;
    const loss = m.loss > 0 ? `${(m.loss * 100).toFixed(1)}% loss` : "no loss";
    ms.title = `League's own ping for your last match (${via}): median ${Math.round(m.median_ms)} ms, p95 ${Math.round(m.p95_ms)} ms, ${loss}.`;
  }
}

function setStatus(text: string, busy = false): void {
  $("status").textContent = text;
  $("live").classList.toggle("busy", busy);
}

// ---------- connections ----------

async function refreshConnections(): Promise<void> {
  try {
    const conns = await api.call<Conn[]>("list_connections");
    state.conns = conns;
    state.lastRefresh = Date.now();
    const procs = new Map<string, Conn[]>();
    for (const c of conns) procs.set(c.process, [...(procs.get(c.process) ?? []), c]);
    state.procs = procs;
    $("connCount").textContent = String(conns.length);
    const pruned = pruneTraces();
    renderProcs();
    rebuildDests();
    if (pruned) draw();
    void locateConns();
  } catch (e) {
    setStatus(`connections unavailable: ${String(e)}`);
  }
}

function rebuildDests(): void {
  const proc = activeProc();
  const list = proc ? state.procs.get(proc) ?? [] : state.conns;
  const dests = new Map<string, Dest>();
  for (const c of list) {
    const key = `${c.proto}:${c.remote_ip}:${c.remote_port}`;
    const d = dests.get(key) ?? { key, ip: c.remote_ip, port: c.remote_port, proto: c.proto, processes: new Set<string>(), count: 0 };
    d.processes.add(c.process);
    d.count++;
    dests.set(key, d);
  }
  state.dests = dests;
  if (state.config.focus) {
    for (const c of state.procs.get(state.config.focus) ?? []) queueTrace(c.remote_ip);
  }
  renderDests();
}

// ---------- tracing ----------

/**
 * Bound the traces kept for destinations whose connection has closed.
 * A queued trace that has not started is cancelled, and finished ones beyond MAX_STALE_TRACES go oldest first.
 * Running traces, live destinations and the selected route are always kept.
 */
function pruneTraces(): boolean {
  const live = new Set(state.conns.map((c) => c.remote_ip));
  const sel = selectedIp();
  const gone = (id: string) => {
    const ip = id.startsWith(SAMPLE) ? id.slice(SAMPLE.length) : id;
    return !ip.startsWith(RELAY) && !live.has(ip) && ip !== sel;
  };
  const cancelled = state.queue.filter(gone);
  state.queue = state.queue.filter((ip) => !gone(ip));
  for (const id of cancelled) {
    if (id.startsWith(SAMPLE)) state.sampleTraces.delete(id);
    else state.traces.delete(id);
  }
  const stale = [...state.traces.values()].filter((t) => t.done && gone(t.target)).sort((a, b) => a.startedAt - b.startedAt);
  const drop = stale.slice(0, Math.max(0, stale.length - MAX_STALE_TRACES));
  for (const t of drop) {
    state.traces.delete(t.target);
    clearTimeout(state.sampling.get(t.target)?.timer);
    state.sampling.delete(t.target);
  }
  return cancelled.length + drop.length > 0;
}

/** Start a trace. `force` re-runs one that already finished; one still running is never doubled. */
function queueTrace(ip: string, force = false): void {
  const t = state.traces.get(ip);
  if (t && (!force || !t.done)) return;
  // A re-run keeps the finished route, so a worse answer this time cannot replace a good one.
  state.traces.set(ip, { id: ip, target: ip, hops: new Map(), done: false, startedAt: Date.now(), previous: t, variants: t?.variants });
  state.queue.push(ip);
  pump();
}

/** Trace the path to a relay once, so its route is drawn through the routers it really uses. */
function queueRelayTrace(host: string): void {
  const id = RELAY + host;
  if (state.relayTraces.has(id)) return;
  state.relayTraces.set(id, { id, target: host, hops: new Map(), done: false, startedAt: Date.now() });
  state.queue.push(id);
  pump();
}

/**
 * Re-trace the selected destination in the background, SAMPLE_RUNS times, SAMPLE_GAP_MS apart.
 * Each run is filed as a path sighting without replacing the route on screen. Sampling pauses
 * while another destination is selected and resumes when this one is picked again.
 */
function scheduleSample(ip: string): void {
  const s = state.sampling.get(ip) ?? { runs: 0 };
  state.sampling.set(ip, s);
  const id = SAMPLE + ip;
  if (s.runs >= SAMPLE_RUNS || s.timer || state.sampleTraces.has(id) || ip !== selectedIp() || !state.traces.get(ip)?.done) return;
  s.timer = setTimeout(() => {
    s.timer = undefined;
    if (ip !== selectedIp() || state.sampleTraces.has(id)) return;
    state.sampleTraces.set(id, { id, target: ip, hops: new Map(), done: false, startedAt: Date.now() });
    state.queue.push(id);
    pump();
    renderRoute();
  }, SAMPLE_GAP_MS);
}

const traceById = (id: string): Trace | undefined => state.traces.get(id) ?? state.relayTraces.get(id) ?? state.sampleTraces.get(id);

function pump(): void {
  while (state.inflight < MAX_CONCURRENT_TRACES && state.queue.length) {
    const ip = state.queue.shift()!;
    state.inflight++;
    api.call("trace", { id: ip, target: traceById(ip)?.target ?? ip, maxHops: 25 }).catch((e) => {
      const t = traceById(ip);
      if (t) Object.assign(t, { done: true, error: String(e) });
      state.sampleTraces.delete(ip);
      state.inflight--;
      pump();
    });
  }
  const n = state.inflight;
  setStatus(n ? `tracing ${n} route${n > 1 ? "s" : ""}${state.queue.length ? `, ${state.queue.length} queued` : ""}` : idleStatus(), n > 0);
}

function wireEvents(): void {
  api.on<HopEvent>("trace:hop", (p) => {
    const t = traceById(p.id);
    if (!t) return;
    // rDNS is looked up once per IP, so a router seen at an earlier hop lends this hop its name.
    const rdns = p.ip ? [...t.hops.values()].find((h) => h.ip === p.ip && h.rdns)?.rdns : undefined;
    t.hops.set(p.hop, { hop: p.hop, ip: p.ip, rtts: p.rtts, avg: p.avg, rdns });
    locateHops(t);
    if (p.id === selectedIp()) renderRoute();
    renderDests();
    draw();
  });
  api.on<RdnsEvent>("trace:rdns", (p) => {
    const t = traceById(p.id);
    // Match by IP, not hop number: the name belongs to every hop that router answered,
    // and a late answer from an earlier run must not name a different router.
    const hops = t ? [...t.hops.values()].filter((h) => h.ip === p.ip) : [];
    if (!t || !hops.length) return;
    for (const h of hops) h.rdns = p.name;
    locateHops(t);
    if (p.id === selectedIp()) {
      renderRoute();
      if (t.done) rankRelays();
    }
    if (p.id.startsWith(RELAY)) rankRelays();
    renderDests();
    draw();
  });
  api.on<DoneEvent>("trace:done", async (p) => {
    const t = traceById(p.id);
    // This run's hops, kept even when an earlier, fuller run is restored, so a changed path is still listed.
    const run = t ? [...t.hops.values()] : [];
    if (t) {
      t.done = true;
      if (!p.ok) t.error = p.error ?? "failed";
      keepBetterRun(t);
    }
    state.inflight = Math.max(0, state.inflight - 1);
    pump();
    if (t && p.id.startsWith(SAMPLE)) {
      await geolocateTrace(t);
      state.sampleTraces.delete(p.id);
      const main = state.traces.get(t.target);
      const s = state.sampling.get(t.target);
      if (s) s.runs++;
      if (main && !t.error) recordVariant(main, run);
      scheduleSample(t.target);
    } else if (t) {
      await geolocateTrace(t, run);
      if (!p.id.startsWith(RELAY)) {
        recordVariant(t, run);
        scheduleSample(t.target);
      } else rankRelays();
    }
    if (t) void stampPassport(run);
    renderDests();
    if (p.id === selectedIp() || (t && p.id.startsWith(SAMPLE) && t.target === selectedIp())) {
      renderRoute();
      rankRelays();
    }
    draw();
    if (p.id === state.pendingFit) fitSelected();
  });
}

/** Replies a run got: whether the destination itself answered, then how many hops did. */
function quality(t: Trace): [number, number] {
  const hops = [...t.hops.values()];
  return [hops.some((h) => h.ip === t.target && h.avg != null) ? 1 : 0, hops.filter((h) => h.avg != null).length];
}

/**
 * After a re-run, keep the earlier route when the new one failed or got fewer replies.
 * Routers often stop answering ICMP for a while, and a list of "No reply" rows says nothing new.
 */
function keepBetterRun(t: Trace): void {
  const prev = t.previous;
  t.previous = undefined;
  if (!prev) return;
  const [nowDest, nowReplies] = quality(t);
  const [wasDest, wasReplies] = quality(prev);
  if (!wasReplies) return;
  const worse = nowDest < wasDest || (nowDest === wasDest && nowReplies < wasReplies);
  if (!t.error && !worse) return;
  const why = t.error ? `failed: ${t.error}` : nowDest < wasDest ? "got no reply from the destination" : `got fewer replies (${nowReplies} of ${t.hops.size} hops)`;
  t.hops = prev.hops;
  t.error = undefined;
  // The card shows "Earlier route kept" with this reason on hover.
  t.note = `Re-trace ${why}.`;
}

/** Place every live connection's far end, so the Home view shows where this PC's traffic goes before any trace. */
async function locateConns(): Promise<void> {
  const ips = [...new Set(state.conns.map((c) => c.remote_ip))].filter((ip) => !isPrivateIp(ip) && !state.geo.has(ip) && !state.connGeoAsked.has(ip));
  if (!ips.length) return;
  for (const ip of ips) state.connGeoAsked.add(ip);
  try {
    let found = false;
    for (const g of await api.call<Geo[]>("geolocate", { ips })) if (g.status === "success") (state.geo.set(g.query, g), (found = true));
    if (found) draw();
  } catch {
    /* no GeoIP: the map just shows traced routes */
  }
}

async function geolocateTrace(t: Trace, extra: Hop[] = []): Promise<void> {
  // The destination is located even when it never answers, so relay estimates can aim at it.
  const ips = [...new Set([...[...t.hops.values(), ...extra].map((h) => h.ip), t.target])].filter((ip): ip is string => !!ip && !isPrivateIp(ip) && !state.geo.has(ip));
  try {
    if (ips.length) for (const g of await api.call<Geo[]>("geolocate", { ips })) if (g.status === "success") state.geo.set(g.query, g);
  } catch (e) {
    setStatus(`geolocation failed: ${String(e)}`);
  }
  locateHops(t);
  if (extra.length) locateHops({ hops: new Map(extra.map((h) => [h.hop, h])) });
}

function locateHops(t: Pick<Trace, "hops">): void {
  const hops = [...t.hops.values()].sort((a, b) => a.hop - b.hop);
  // The first hop is always this network's own router. Over IPv6 it answers from a global
  // address, which GeoIP files under the ISP's city instead of home.
  const isHome = (h: Hop) => !!h.ip && (h.hop === 1 || isPrivateIp(h.ip));
  // Delay spent in the access network before the first ISP router: it covers no distance.
  const baseline = Math.min(...hops.filter((h) => h.ip && !isHome(h)).map((h) => minRtt(h.rtts) ?? Infinity));
  for (const h of hops) {
    if (!h.ip) {
      // A hop that timed out has no location. Placing it anywhere draws an arc that was never travelled.
      Object.assign(h, { lat: undefined, lng: undefined, place: "No reply", source: undefined });
      continue;
    }
    if (isHome(h)) {
      if (state.home) Object.assign(h, { lat: state.home.lat, lng: state.home.lng, place: h.hop === 1 ? "Home network" : "Private address", source: "home" });
      continue;
    }
    // rDNS first, GeoIP second, and neither when it is farther away than the hop's RTT allows.
    const cands: Pick<Hop, "lat" | "lng" | "place" | "source">[] = [];
    const p = h.rdns ? placeFromRdns(h.rdns) : undefined;
    if (p) cands.push({ lat: p.lat, lng: p.lng, place: p.name, source: "rdns" });
    const g = state.geo.get(h.ip);
    if (g && g.lat != null && g.lon != null) cands.push({ lat: g.lat, lng: g.lon, place: geoPlace(g, h.ip), source: "geo" });
    const best = minRtt(h.rtts);
    // A router name is held to the physical limit only; GeoIP to the realistic one.
    const fits = (c: (typeof cands)[number]) =>
      !state.home || best == null || (c.source === "rdns" ? plausibleForRtt(state.home.lat, state.home.lng, c.lat!, c.lng!, best) : plausibleForRtt(state.home.lat, state.home.lng, c.lat!, c.lng!, best, REALISTIC, Number.isFinite(baseline) ? baseline : 0));
    const ok = cands.find(fits);
    h.implausible = undefined;
    h.estimated = undefined;
    if (ok) Object.assign(h, ok);
    else if (cands.length) {
      Object.assign(h, { lat: undefined, lng: undefined, source: undefined, place: `${cands[0].place}? Too far for ${best!.toFixed(0)} ms`, implausible: cands[0].place });
    }
  }
  checkGeoAgainstNeighbours(hops, Number.isFinite(baseline) ? baseline : 0);
  // Detour: a hop that moves farther from where the route ends than the previous located hop was.
  const end = hops.filter((h) => h.lat != null && h.source !== "home").pop();
  let last = state.home ? { lat: state.home.lat, lng: state.home.lng } : undefined;
  for (const h of hops) {
    h.detour = false;
    if (h.lat == null || h.lng == null || h.source === "home") continue;
    if (end && h !== end && last) {
      const before = haversineKm(last.lat, last.lng, end.lat!, end.lng!);
      const after = haversineKm(h.lat, h.lng, end.lat!, end.lng!);
      h.detour = after - before > 150;
    }
    last = { lat: h.lat, lng: h.lng };
  }
}

/**
 * A GeoIP place that does not fit the hops around it, by RTT, moves to the last trusted hop and is
 * marked as estimated. The hop keeps its network, so the journey by ASN is unchanged.
 * Trusted: home, router names, and GeoIP places that passed this check.
 */
function checkGeoAgainstNeighbours(hops: Hop[], baselineMs: number): void {
  if (!state.home) return;
  const floors = floorRtts(hops);
  const anchorOf = (h: Hop): Anchor | undefined => {
    const f = floors.get(h.hop);
    return h.lat != null && h.lng != null && f != null ? { lat: h.lat, lng: h.lng, floorMs: f } : undefined;
  };
  const last = hops.filter((h) => h.avg != null).pop();
  let prev: Anchor = { lat: state.home.lat, lng: state.home.lng, floorMs: baselineMs };
  let prevPlace = state.home.label;
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    if (h.source === "home" || h.lat == null) continue;
    const at = anchorOf(h);
    if (h.source === "geo" && at) {
      // The next hop placed by its router name, or the destination when it is the last to answer.
      const nextHop = hops.slice(i + 1).find((x) => x.source === "rdns" || (x === last && x.lat != null && x.source !== "home"));
      const next = nextHop ? anchorOf(nextHop) : undefined;
      if (!fitsNeighbours(prev, at, next)) {
        const gained = Math.max(0, at.floorMs - prev.floorMs);
        Object.assign(h, { lat: prev.lat, lng: prev.lng, estimated: `GeoIP said ${h.place}, too far for +${gained.toFixed(0)} ms`, place: prevPlace });
        continue;
      }
    }
    if (at) {
      prev = at;
      prevPlace = h.place ?? prevPlace;
    }
  }
}

const geoPlace = (g: Geo, fallback: string): string => [g.city, g.regionName].filter(Boolean).join(", ") || g.country || fallback;

function minRtt(rtts: (number | null)[]): number | undefined {
  const good = rtts.filter((v): v is number => v != null);
  return good.length ? Math.min(...good) : undefined;
}

// ---------- journeys and alternate paths ----------

const home = () => state.home ?? undefined;
const segsOf = (hops: Hop[]): Segment[] => segments(hops, state.geo, home());
const keyOf = (hops: Hop[]): string[] => pathKey(segsOf(hops));

/**
 * File a finished run under the path it took. A run that matches a known path (same networks,
 * same cities give or take a router that stayed silent) counts as another sighting of it.
 * The hop objects are shared with the run, so names and places that arrive later reach the variant too.
 */
function recordVariant(t: Trace, run: Hop[]): void {
  const hops = [...run].sort((a, b) => a.hop - b.hop);
  if (!hops.some((h) => h.avg != null)) return;
  const key = keyOf(hops);
  if (!key.length) return;
  const dest = hops.find((h) => h.ip === t.target && h.avg != null);
  const rtt = dest?.avg ?? hops.filter((h) => h.avg != null).pop()?.avg ?? undefined;
  const v: RouteVariant = { key, hops, rtt, destReplied: !!dest, runs: 1, lastSeen: Date.now() };
  const vs = (t.variants ??= []);
  const same = vs.find((x) => samePath(x.key, key));
  if (same) {
    // The fuller sighting describes the path, the latest one gives its time.
    Object.assign(same, { runs: same.runs + 1, lastSeen: v.lastSeen, rtt, destReplied: v.destReplied }, key.length >= same.key.length ? { key, hops } : {});
  } else {
    vs.push(v);
    if (vs.length > MAX_VARIANTS) vs.splice(vs.indexOf([...vs].sort((a, b) => a.lastSeen - b.lastSeen)[0]), 1);
  }
}

/** Index of the variant the displayed route is, if any. Keys are rebuilt because rDNS can name a router late. */
function currentVariant(t: Trace): number {
  const key = keyOf([...t.hops.values()]);
  for (const v of t.variants ?? []) v.key = keyOf(v.hops);
  return (t.variants ?? []).findIndex((v) => samePath(v.key, key));
}

const variantName = (i: number): string => `Path ${String.fromCharCode(65 + i)}`;

/**
 * What the destination is, in words: who runs it, where, and what for. The port and how a silent
 * server was placed are on hover. `place` is the town the line names, if any, and `flags` its tags.
 */
function destinationLine(t: Trace): { html: string; title: string; place?: string; flags: string[] } {
  const d = state.selectedDest ? state.dests.get(state.selectedDest) : undefined;
  const g = state.geo.get(t.target);
  const destHop = [...t.hops.values()].find((h) => h.ip === t.target);
  const owner = networkOf({ hop: 0, ip: t.target, rtts: [], avg: null, rdns: destHop?.rdns }, g)?.name;
  const end = routeEnd(t);
  const svc = d ? service(d.port) : undefined;
  const role = svc === "game" ? "game server" : svc === "stun" || svc === "wireguard" || svc === "vpn" ? "relay" : svc ? `${svc} server` : "server";
  const who = d ? [...d.processes].map(esc).join(", ") : "This machine";
  const place = end && end.replied ? end.place : g?.city ? geoPlace(g, t.target) : undefined;
  const answered = [...t.hops.values()].some((h) => h.avg != null);
  const flags =
    t.done && !end?.replied
      ? [`<span class="chip" title="Does not answer traces${g?.city ? ", so its place is from GeoIP" : ""}.${answered ? " The time shown is the last hop that answered." : ""}">no reply</span>`]
      : [];
  return {
    html: `<b>${who}</b> → ${owner ? `<b>${esc(owner)}</b> ` : ""}${role}${place ? ` in <b>${esc(place)}</b>` : ""}`,
    title: d ? `${d.proto.toUpperCase()} port ${d.port}` : "",
    place,
    flags,
  };
}

// ---------- relays ----------

async function loadConfig(): Promise<void> {
  try {
    state.config = await api.call<Config>("read_config");
  } catch {
    state.config = { relays: [] };
  }
  state.config.relays ??= [];
}

/** Every relay to measure: the ones added here, then the saved WireGuard relays. */
function allRelays(): Relay[] {
  return [...state.config.relays, ...state.tunnelRelays];
}

/** The WireGuard relays saved in the Relay section, by endpoint host, skipping hosts added here too. */
async function loadTunnelRelays(): Promise<void> {
  let saved: { name: string | null; endpoint: string }[] = [];
  try {
    saved = await api.call<{ name: string | null; endpoint: string }[]>("relay_list");
  } catch {
    /* no relay section data: the list stays as it was */
    return;
  }
  const mine = new Set(state.config.relays.map((r) => r.host.toLowerCase()));
  state.tunnelRelays = saved
    .map((s) => ({ name: s.name ?? "Relay", host: s.endpoint.replace(/^\[(.*)\]:\d+$/, "$1").replace(/^([^:]+):\d+$/, "$1"), tunnel: true }))
    .filter((r) => !mine.has(r.host.toLowerCase()));
  for (const host of [...state.relayMeasures.keys()]) if (!allRelays().some((r) => r.host === host)) state.relayMeasures.delete(host);
}

async function saveConfig(): Promise<void> {
  await api.call("write_config", { config: state.config });
}

async function measureRelays(): Promise<void> {
  for (const r of allRelays()) {
    if (!isPrivateIp(r.host)) queueRelayTrace(r.host);
    try {
      const s = await api.call<PingStats>("ping_stats", { host: r.host, count: 10 });
      const m: RelayMeasure = { relay: r, rtt: s.avg, lat: r.lat ?? undefined, lng: r.lng ?? undefined };
      if (m.lat == null && !isPrivateIp(r.host)) {
        const g = (await api.call<Geo[]>("geolocate", { ips: [r.host] }))[0];
        if (g?.status === "success" && g.lat != null && g.lon != null) {
          // Anycast relays (1.1.1.1) answer from nearby while GeoIP names one far-off city.
          const best = s.min ?? s.avg;
          if (state.home && best != null && !plausibleForRtt(state.home.lat, state.home.lng, g.lat, g.lon, best)) m.geoNote = `GeoIP says ${geoPlace(g, r.host)}, too far for ${best.toFixed(0)} ms`;
          else Object.assign(m, { lat: g.lat, lng: g.lon });
        }
      }
      state.relayMeasures.set(r.host, m);
    } catch {
      state.relayMeasures.set(r.host, { relay: r, rtt: null });
    }
    rankRelays();
    draw();
  }
}

/**
 * Where relay estimates aim, and the RTT they are compared with.
 * A destination that drops ICMP has no measured RTT, so there is nothing to compare against.
 * Its own geolocation is used when known, otherwise the last located router stands in.
 */
function routeEnd(t: Trace | undefined): { lat: number; lng: number; place: string; rtt?: number; replied: boolean } | undefined {
  if (!t) return undefined;
  const hops = [...t.hops.values()].sort((a, b) => a.hop - b.hop);
  const dest = hops.find((h) => h.ip === t.target && h.avg != null);
  const rtt = dest?.avg ?? undefined;
  if (dest?.lat != null && dest.lng != null) return { lat: dest.lat, lng: dest.lng, place: dest.place ?? t.target, rtt, replied: true };
  const g = state.geo.get(t.target);
  if (g?.lat != null && g.lon != null && !dest?.implausible) return { lat: g.lat, lng: g.lon, place: [g.city, g.regionName].filter(Boolean).join(", ") || g.country || t.target, rtt, replied: !!dest };
  const last = hops.filter((h) => h.lat != null && h.source !== "home").pop();
  return last ? { lat: last.lat!, lng: last.lng!, place: last.place ?? last.ip ?? "", rtt, replied: !!dest } : undefined;
}

let rankedRelays: RelayMeasure[] = [];

function rankRelays(): RelayMeasure[] {
  const end = routeEnd(selectedTrace());
  const ranked: RelayMeasure[] = [];
  for (const r of allRelays()) {
    const m = state.relayMeasures.get(r.host) ?? { relay: r, rtt: null };
    if (m.rtt != null && end && m.lat != null && m.lng != null) {
      m.legEst = estimateLegMs(haversineKm(m.lat, m.lng, end.lat, end.lng));
      m.total = m.rtt + m.legEst;
    } else {
      m.legEst = undefined;
      m.total = undefined;
    }
    ranked.push(m);
  }
  ranked.sort((a, b) => (a.total ?? 1e9) - (b.total ?? 1e9) || (a.rtt ?? 1e9) - (b.rtt ?? 1e9));
  if (!state.selectedRelay || !ranked.some((m) => m.relay.host === state.selectedRelay)) state.selectedRelay = ranked.find((m) => m.total != null)?.relay.host ?? null;
  rankedRelays = ranked;
  renderRank(ranked);
  renderRoutes(selectedTrace());
  return ranked;
}

// ---------- rendering: panels ----------

const selectedIp = (): string | null => (state.selectedDest ? state.dests.get(state.selectedDest)?.ip ?? state.selectedDest.split(":").slice(1, -1).join(":") : null);
const selectedTrace = (): Trace | undefined => {
  const ip = selectedIp();
  return ip ? state.traces.get(ip) : undefined;
};
const matches = (s: string) => !state.filter || s.toLowerCase().includes(state.filter);
/** A process row matches the filter by its name or by any address it talks to. */
const procMatches = (name: string) => matches(name) || (state.procs.get(name) ?? []).some((c) => matches(c.remote_ip));
/** The selected process, unless the filter hides it: then destinations come from every process. */
const activeProc = (): string | null => (state.selectedProc && procMatches(state.selectedProc) ? state.selectedProc : null);

// Lists are patched in place, keyed by row, and clicks are handled once on the list.
// Rebuilding rows on every hop event dropped clicks whose press and release landed on different elements.
function patchList(ul: HTMLElement, rows: { key: string; html: string; selected: boolean }[], empty: string): void {
  const existing = new Map<string, HTMLLIElement>();
  for (const li of [...ul.children] as HTMLLIElement[]) {
    if (li.dataset.key) existing.set(li.dataset.key, li);
    else li.remove();
  }
  if (!rows.length) {
    for (const li of existing.values()) li.remove();
    ul.innerHTML = `<li class="empty">${empty}</li>`;
    return;
  }
  rows.forEach((r, i) => {
    let li = existing.get(r.key);
    existing.delete(r.key);
    if (!li) {
      li = document.createElement("li");
      li.dataset.key = r.key;
      li.tabIndex = 0;
      li.setAttribute("role", "option");
    }
    if (li.dataset.html !== r.html) {
      li.innerHTML = r.html;
      li.dataset.html = r.html;
    }
    li.setAttribute("aria-selected", String(r.selected));
    if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] ?? null);
  });
  for (const li of existing.values()) li.remove();
}

function renderProcs(): void {
  const rows = [...state.procs.entries()].filter(([n]) => procMatches(n)).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const max = Math.max(1, ...rows.map(([, l]) => l.length));
  patchList(
    $("procs"),
    rows.map(([name, list]) => {
      const focused = state.config.focus === name;
      return {
        key: name,
        selected: state.selectedProc === name,
        html: `<span class="primary">${esc(name)}</span><span class="secondary">${list.length}</span><button class="pin" type="button" aria-pressed="${focused}" title="${focused ? "Focused: every destination is traced automatically" : "Focus this process"}">${focused ? "●" : "○"}</button><span class="bar"><i style="width:${Math.round((list.length / max) * 100)}%"></i></span>`,
      };
    }),
    state.filter ? "No process matches" : "No outbound connections",
  );
}

function renderDests(): void {
  const proc = activeProc();
  $("destLabel").textContent = proc ? `Destinations · ${proc}` : "Destinations · all";
  $("destLabel").title = $("destLabel").textContent;
  const rows = [...state.dests.values()].filter((d) => matches(d.ip) || [...d.processes].some(matches)).sort((a, b) => b.count - a.count || a.ip.localeCompare(b.ip));
  patchList(
    $("dests"),
    rows.map((d) => {
      const t = state.traces.get(d.ip);
      const hops = t ? [...t.hops.values()] : [];
      const last = hops.filter((h) => h.avg != null).pop();
      const far = hops.filter((h) => h.place && h.lat != null && h.source !== "home").pop();
      const ms = last?.avg != null ? `${last.avg.toFixed(0)} ms` : t ? (t.done ? "no reply" : "…") : "";
      const svc = service(d.port);
      return {
        key: d.key,
        selected: state.selectedDest === d.key,
        html:
          `<span class="primary"><span class="dot ${t ? (t.done ? "done" : "tracing") : ""}"></span>${esc(d.ip)}<span style="color:var(--ink-3)">:${d.port}</span>${svc ? `<span class="tag">${svc}</span>` : ""}</span>` +
          `<span class="secondary ${t?.done ? "live" : ""}">${ms}</span>` +
          `<span class="sub">${d.proto} · ${[...d.processes].map(esc).join(", ")}${far?.place ? ` · ${esc(far.place)}` : ""}</span>`,
      };
    }),
    state.filter ? "No destination matches" : "Nothing outbound right now",
  );
}

/** Select a destination. Clicking the selected one again re-runs its trace once it has finished. */
function selectDest(key: string): void {
  const d = state.dests.get(key);
  if (!d) return;
  const again = state.selectedDest === key;
  state.selectedDest = key;
  state.selectedRelay = null;
  state.selectedVariant = null;
  const t = state.traces.get(d.ip);
  queueTrace(d.ip, again);
  scheduleSample(d.ip);
  renderDests();
  renderRoute();
  rankRelays();
  draw();
  if (t?.done && !again) fitSelected();
  else state.pendingFit = d.ip;
}

function fitSelected(): void {
  state.pendingFit = null;
  // The race and the passport keep their own framing while a trace finishes behind them.
  if (state.race.open || state.passport.open || state.gainMap.open) return;
  const pts = routePoints(selectedTrace());
  if (pts.length > 1) globe.fitPoints(pts);
}

function renderRoute(): void {
  const t = selectedTrace();
  const ol = $("hops");
  ol.innerHTML = "";
  // With nothing picked, the floating route card has nothing to say, so it stays out of the globe's way.
  $("summary").classList.toggle("idle", !t);
  if (!t) {
    $("routeTarget").textContent = "";
    $("routeTotal").textContent = "—";
    $("routeStats").innerHTML = "";
    $("hopCount").textContent = "";
    $("routeMeta").textContent = "Pick a destination to trace it.";
    $("routeDest").innerHTML = "";
    $("routeDest").title = "";
    ol.innerHTML = `<li class="empty">Hops appear here as the trace runs.</li>`;
    renderJourney(undefined, []);
    renderRoutes(undefined);
    return;
  }
  const hops = [...t.hops.values()].sort((a, b) => a.hop - b.hop);
  const last = hops.filter((h) => h.avg != null).pop();
  $("routeTarget").textContent = t.target;
  $("routeTotal").innerHTML = last?.avg != null ? `${last.avg.toFixed(0)}<small>ms</small>` : t.done ? `<small>no reply</small>` : "…";
  const dest = destinationLine(t);
  $("hopCount").textContent = String(hops.length);
  const located = hops.filter((h) => h.lat != null && h.source !== "home");
  let pathKm = 0;
  let prev: { lat: number; lng: number } | null = state.home;
  for (const h of located) {
    if (prev) pathKm += haversineKm(prev.lat, prev.lng, h.lat!, h.lng!);
    prev = { lat: h.lat!, lng: h.lng! };
  }
  const end = located[located.length - 1];
  const direct = state.home && end ? haversineKm(state.home.lat, state.home.lng, end.lat!, end.lng!) : 0;
  const detours = hops.filter((h) => h.detour).length;
  const segs = segsOf(hops);
  const segOf = new Map<Hop, Segment>();
  for (const sg of segs) for (const h of sg.hops) segOf.set(h, sg);
  const jump = biggestJump(hops);
  // Tags trail the destination line, each after a widened space rather than a margin, so one that
  // wraps starts flush left. What each one means is on hover.
  if (detours) dest.flags.push(`<span class="chip" title="${detours === 1 ? "1 hop moves" : `${detours} hops move`} more than 150 km away from where the route ends">${detours} backwards</span>`);
  $("routeDest").innerHTML = dest.html + dest.flags.map((f) => `<span class="gap"> </span>${f}`).join("");
  $("routeDest").title = dest.title;
  $("routeStats").innerHTML = `<div><b>${hops.length}</b><span>hops</span></div><div><b>${pathKm ? pathKm.toFixed(0) : "—"}</b><span>km path</span></div><div><b>${direct ? direct.toFixed(0) : "—"}</b><span>km direct</span></div>`;
  // One short line each. Where the route ends only shows when it is not the town the destination line names.
  const lines: string[] = [];
  if (!end) lines.push(t.done ? "No located hop replied" : "Tracing");
  else if (!dest.place || town(dest.place) !== town(end.place ?? "")) lines.push(`Ends near <b>${esc(end.place ?? "")}</b>`);
  if (jump) {
    const a = segOf.get(jump.from);
    const b = segOf.get(jump.to);
    const at = (h: Hop) => (h.lat != null && h.source !== "home" ? town(h.place ?? "") : h.source === "home" ? "your network" : `hop ${h.hop}`);
    const nets = a && b && a !== b ? `${a.net.name} → ${b.net.name}` : b ? `Inside ${b.net.name}` : "";
    lines.push(`<span title="${esc(nets)}">Most time: <b>+${jump.ms.toFixed(0)} ms</b>, ${esc(at(jump.from))} → ${esc(at(jump.to))}</span>`);
  }
  if (t.error) lines.push(esc(t.error));
  if (t.note) lines.push(`<span title="${esc(t.note)}">Earlier route kept</span>`);
  $("routeMeta").innerHTML = lines.join("<br>");
  renderJourney(t, segs);
  renderRoutes(t);

  const floors = floorRtts(hops);
  let prevFloor = 0;
  let prevSeg: Segment | undefined;
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    // A header row wherever the route enters another network.
    const sg = segOf.get(h);
    if (sg && sg !== prevSeg && sg.net.id !== "home") {
      const head = document.createElement("li");
      head.className = "net";
      head.innerHTML = `<span></span><div>${esc(sg.net.name)}${sg.net.asn ? `<span class="asn">${esc(sg.net.asn)}</span>` : ""}</div>`;
      ol.appendChild(head);
    }
    if (sg) prevSeg = sg;
    const li = document.createElement("li");
    // A run of silent hops folds into one row.
    let j = i;
    while (!h.ip && j + 1 < hops.length && !hops[j + 1].ip) j++;
    if (j > i) {
      li.className = "silent";
      li.innerHTML = `<span class="ms none">·</span><div><div class="where">No reply · ${j - i + 1} hops</div><div class="who">hops ${h.hop}–${hops[j].hop}</div></div>`;
      ol.appendChild(li);
      i = j;
      continue;
    }
    const located = h.lat != null && h.source !== "home";
    li.className = located ? "located" : h.ip ? "" : "silent";
    const ms = h.avg != null ? h.avg.toFixed(0) : "·";
    const f = floors.get(h.hop);
    const add = f != null ? f - prevFloor : 0;
    if (f != null) prevFloor = f;
    const addTag = add >= 5 ? `<span class="add${jump?.to === h ? " worst" : ""}">+${add.toFixed(0)}</span>` : "";
    li.innerHTML = `<span class="ms ${h.avg == null ? "none" : ""}">${ms}${addTag}</span><div><div class="where">${esc(h.place ?? (h.ip ? "Locating" : "No reply"))}${h.detour ? `<span class="flag">backwards</span>` : ""}${h.estimated ? `<span class="flag" title="${esc(h.estimated)}">estimated</span>` : ""}</div><div class="who">${esc(h.rdns ?? h.ip ?? `hop ${h.hop}`)}</div></div>`;
    if (located) li.addEventListener("click", () => globe.flyTo(h.lat!, h.lng!, 0.6, 900, 8));
    ol.appendChild(li);
  }
}

/**
 * One row per network the packets cross, with the time each one adds. A row names the network, then
 * where it carries the packets and how far. Its ASN and hop range, which the Hops list also shows, are on hover.
 */
function renderJourney(t: Trace | undefined, segs: Segment[]): void {
  const ol = $("journey");
  $("journeyChain").textContent = segs.length ? `${segs.filter((x) => x.net.id !== "home").length} networks` : "";
  if (!t || !segs.length) {
    ol.innerHTML = `<li class="empty">${t ? (t.done ? "No hop answered." : "Waiting for hops.") : "Pick a destination."}</li>`;
    return;
  }
  const worst = segs.reduce<Segment | undefined>((w, x) => ((x.addedMs ?? 0) > (w?.addedMs ?? 0) ? x : w), undefined);
  const total = Math.max(1, ...segs.map((x) => x.exitMs ?? 0));
  const rows = segs.map((sg) => {
    const places = sg.from && sg.to && town(sg.from) !== town(sg.to) ? `${esc(town(sg.from))} → ${esc(town(sg.to))}` : sg.from ? esc(town(sg.from)) : "";
    const km = sg.km && sg.km >= 50 ? `${sg.km.toFixed(0)} km` : "";
    // Your network is where This PC sits on the globe, so its row needs no second line.
    const sub = sg.net.id === "home" ? "" : [places, km].filter(Boolean).join(" · ");
    const hopsTxt = sg.first === sg.last ? `hop ${sg.first}` : `hops ${sg.first}–${sg.last}`;
    const tip = [sg.net.asn, hopsTxt].filter(Boolean).join(" · ");
    const add = sg.addedMs != null ? `+${sg.addedMs.toFixed(0)}` : "·";
    const w = sg.addedMs != null ? Math.max(2, Math.round((sg.addedMs / total) * 100)) : 0;
    const cls = [sg === worst && (worst.addedMs ?? 0) >= 5 ? "worst" : "", sg.slow ? "slow" : ""].join(" ").trim();
    return `<li class="${cls}" title="${esc(tip)}"><span class="add">${add}<small>ms</small></span><div><div class="where">${esc(sg.net.name)}${sg.slow ? `<span class="flag" title="Adds more time than its distance explains">slow for distance</span>` : ""}</div>${sub ? `<div class="who">${sub}</div>` : ""}<span class="bar"><i style="width:${w}%"></i></span></div></li>`;
  });
  const end = routeEnd(t);
  if (t.done && end && !end.replied) rows.push(`<li class="end" title="The last answering hop is the closest measured point"><span class="add">?</span><div><div class="where">Destination did not answer</div></div></li>`);
  ol.innerHTML = rows.join("");
}

/** Every way to this destination seen so far: paths from background and manual re-traces, and routes through each relay. */
function renderRoutes(t: Trace | undefined): void {
  const el = $("routes");
  el.innerHTML = "";
  if (!t) {
    $("routesCount").textContent = "";
    el.innerHTML = `<div class="empty">Pick a destination.</div>`;
    return;
  }
  const cur = currentVariant(t);
  const vs = t.variants ?? [];
  const now = cur >= 0 ? vs[cur].rtt : routeEnd(t)?.rtt;
  // `sw` is the line style the row is drawn in on the globe, so each drawn row matches the legend.
  // A relay row is an overlay on the current path, not a second selection: it shows its line, not the selection bar.
  const rows: { name: string; ms: string; detail: string; selected: boolean; sw?: "now" | "alt" | "best"; overlay?: boolean; onClick?: () => void }[] = [];
  // Name a path by the towns only it passes through. With one path, by where it changes networks.
  const towns = vs.map((v) => new Set(viaCities(v.key)));
  vs.forEach((v, i) => {
    const segs = segsOf(v.hops);
    const own = [...towns[i]].filter((x) => towns.some((o, j) => j !== i && !o.has(x)));
    const via = vs.length > 1 && own.length ? own : segs.filter((x) => x.net.id !== "home" && x.to).map((x) => town(x.to!));
    const delta = i !== cur && v.rtt != null && now != null ? ` <span class="delta">${v.rtt - now <= 0 ? "" : "+"}${(v.rtt - now).toFixed(0)} ms vs current</span>` : "";
    rows.push({
      name: `${variantName(i)}${i === cur ? " · current" : ""}`,
      ms: v.rtt != null ? `${v.rtt.toFixed(0)} ms${v.destReplied ? "" : "*"}` : "no reply",
      detail: `${esc(netChain(segs) || "unnamed networks")}${via.length ? ` · via ${[...new Set(via)].map(esc).join(", ")}` : ""} · seen ${v.runs}×${delta}`,
      selected: i === cur ? state.selectedVariant == null || state.selectedVariant === i : state.selectedVariant === i,
      sw: i === cur ? "now" : state.selectedVariant === i ? "alt" : undefined,
      onClick: () => {
        state.selectedVariant = i === cur || state.selectedVariant === i ? null : i;
        renderRoutes(t);
        draw();
        // Frame both paths, so the one just picked is in view.
        const alt = state.selectedVariant != null ? routePoints({ hops: new Map(v.hops.map((h) => [h.hop, h])) }) : [];
        globe.fitPoints([...routePoints(t), ...alt]);
      },
    });
  });
  for (const m of rankedRelays) {
    if (m.total == null) continue;
    const rt = state.relayTraces.get(RELAY + m.relay.host);
    const chain = rt ? netChain(segsOf([...rt.hops.values()])) : "";
    const delta = now != null ? ` <span class="delta">${m.total - now <= 0 ? "" : "+"}${(m.total - now).toFixed(0)} ms vs current</span>` : "";
    rows.push({
      name: `Via ${m.relay.name}`,
      ms: `~${m.total.toFixed(0)} ms`,
      detail: `${chain ? `${esc(chain)}, ` : ""}${m.rtt!.toFixed(0)} ms measured to relay + ~${m.legEst!.toFixed(0)} ms estimated onward${delta}`,
      selected: state.selectedRelay === m.relay.host,
      sw: state.selectedRelay === m.relay.host ? "best" : undefined,
      overlay: true,
      onClick: () => {
        state.selectedRelay = m.relay.host;
        renderRank(rankedRelays);
        renderRoutes(t);
        draw();
      },
    });
  }
  $("routesCount").textContent = rows.length ? String(rows.length) : "";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = r.overlay ? "r overlay" : "r";
    row.setAttribute("aria-selected", String(r.selected));
    row.innerHTML = `<span class="nm">${r.sw ? `<i class="sw ${r.sw}" title="Drawn on the globe"></i>` : ""}${esc(r.name)}</span><span class="tot">${r.ms}</span><span></span><span class="br">${r.detail}</span>`;
    if (r.onClick) activatable(row, r.onClick);
    el.appendChild(row);
  }
  const s = state.sampling.get(t.target);
  const sampled = s?.runs ?? 0;
  const busy = state.sampleTraces.has(SAMPLE + t.target);
  const sampling = sampled < SAMPLE_RUNS ? (busy ? `Re-tracing now (${sampled + 1} of ${SAMPLE_RUNS}).` : `Re-tracing every ${SAMPLE_GAP_MS / 1000} s while selected: ${sampled} of ${SAMPLE_RUNS} done.`) : "";
  if (vs.length <= 1) {
    el.insertAdjacentHTML("beforeend", `<div class="empty">${t.done || vs.length ? "One path seen so far." : "Tracing."} ${sampling || "Click the destination again to re-trace."} A path that changes is listed here.${rankedRelays.length ? "" : " Add a relay to compare a route through it."}</div>`);
  } else if (sampling) el.insertAdjacentHTML("beforeend", `<div class="foot">${sampling}</div>`);
  if (vs.some((v) => !v.destReplied)) el.insertAdjacentHTML("beforeend", `<div class="foot">* destination silent: time to the last answering hop.</div>`);
}

/** A clickable row that the keyboard can reach and pick with Enter or Space, like the lists. */
function activatable(row: HTMLElement, onPick: () => void): void {
  row.tabIndex = 0;
  row.setAttribute("role", "option");
  row.addEventListener("click", onPick);
  row.addEventListener("keydown", (e) => {
    if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    // Picking re-renders the list: keep focus on the row at the same place.
    const parent = row.parentElement;
    const at = parent ? [...parent.children].indexOf(row) : -1;
    onPick();
    (parent?.children[at] as HTMLElement | undefined)?.focus();
  });
}

/** Whether the tunnel runs through this saved WireGuard relay. */
function tunnelOf(r: Relay): "on" | "partly" | "off" {
  const t = state.tunnel;
  if (!r.tunnel || !t || t.name !== r.name) return "off";
  return t.state === "up" ? "on" : t.state === "down" ? "off" : "partly";
}

function renderRank(ranked: RelayMeasure[]): void {
  const el = $("relayRank");
  el.innerHTML = "";
  const t = selectedTrace();
  const end = routeEnd(t);
  const current = end?.rtt;
  if (!ranked.length) {
    el.innerHTML = `<div class="empty">No relays yet. Add a VPS, a Tailscale exit node or a gaming-VPN node to compare it against the current path.</div>`;
    return;
  }
  // How the list works is on hover over its heading, not a paragraph above it.
  el.closest(".block")?.querySelector(".label > span")?.setAttribute(
    "title",
    ranked.some((m) => m.relay.tunnel)
      ? "Click a relay to preview its route on the map. Only “Use this relay” sends your game traffic through it. Auto in the Relay section picks for you."
      : "Click a relay to preview its route on the map. These are for comparing only. Join a relay in the Relay section to play through one.",
  );
  for (const m of ranked) {
    const row = document.createElement("div");
    row.className = "r";
    row.setAttribute("aria-selected", String(state.selectedRelay === m.relay.host));
    const delta = m.total != null && current != null ? m.total - current : undefined;
    // The right column is the whole path. With no estimate it shows a dash, never the relay leg alone.
    const right = m.total != null ? `~${m.total.toFixed(0)} ms` : m.rtt != null ? "—" : state.relayMeasures.has(m.relay.host) ? "no reply" : "…";
    const detail =
      m.rtt == null
        ? esc(m.relay.host)
        : `${m.rtt.toFixed(0)} ms to relay` + (m.legEst != null ? ` + ~${m.legEst.toFixed(0)} ms onward` : m.geoNote ? ` · ${esc(m.geoNote)}` : t ? " · destination not located" : " · pick a destination to compare") + (delta != null ? ` <span class="delta">${delta <= 0 ? "" : "+"}${delta.toFixed(0)} ms vs now</span>` : "");
    // A WireGuard relay is removed in the Relay section, where its config lives.
    const x = m.relay.tunnel ? "" : `<button class="x" type="button" title="Remove relay">×</button>`;
    const tun = m.relay.tunnel ? tunnelOf(m.relay) : undefined;
    const picked = state.selectedRelay === m.relay.host;
    // A picked row only previews: say so on the row, so the highlight is not read as connected.
    const offText = picked ? "Previewing" : "";
    const act = tun
      ? `<span class="act"><span>${tun === "on" ? "In use" : tun === "partly" ? "Partly on" : offText}</span><button class="btn tiny" type="button" data-act="${tun === "off" ? "connect" : "off"}"${relayUi?.busy() ? " disabled" : ""}>${tun === "off" ? "Use this relay" : "Turn relay off"}</button></span>`
      : "";
    row.classList.toggle("on", tun === "on");
    row.title = tun === "on" ? "Your game traffic goes through this relay" : "Click to preview this relay's route on the map. This does not connect.";
    row.innerHTML = `<span class="nm">${esc(m.relay.name)}${m.relay.tunnel ? ` <span class="secondary">WireGuard</span>` : ""}</span><span class="tot">${right}</span>${x}<span class="br">${detail}</span>${act}`;
    row.querySelector<HTMLButtonElement>("[data-act]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if ((e.currentTarget as HTMLElement).dataset.act === "connect") void relayUi?.connect(m.relay.name);
      else relayUi?.disconnect();
    });
    activatable(row, () => {
      state.selectedRelay = m.relay.host;
      renderRank(ranked);
      renderRoutes(selectedTrace());
      draw();
    });
    row.querySelector<HTMLButtonElement>(".x")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      state.config.relays = state.config.relays.filter((x) => x !== m.relay);
      state.relayMeasures.delete(m.relay.host);
      state.relayTraces.delete(RELAY + m.relay.host);
      await saveConfig();
      rankRelays();
      draw();
    });
    el.appendChild(row);
  }
}

// ---------- rendering: globe ----------

function routePoints(t: Pick<Trace, "hops"> | undefined): { lat: number; lng: number }[] {
  if (!t) return [];
  const pts: { lat: number; lng: number }[] = state.home ? [state.home] : [];
  for (const h of [...t.hops.values()].sort((a, b) => a.hop - b.hop)) if (h.lat != null && h.lng != null) pts.push({ lat: h.lat, lng: h.lng });
  return pts;
}

function draw(): void {
  const arcs: ArcDatum[] = [];
  const points = new Map<string, PointDatum>();
  const sel = selectedIp();
  const RANK: Record<NodeKind, number> = { home: 0, relay: 1, hop: 2 };

  // Label candidates. The globe places them for the current zoom. Lower priority number wins the spot.
  const wants: LabelWant[] = [];
  // Network territories under the selected route: the faction map.
  const terrs: Territory[] = [];
  const addPoint = (lat: number, lng: number, label: string, detail: string, kind: NodeKind, bright: boolean, text?: string, prio = 3, ref = false) => {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    let p = points.get(key);
    if (p) {
      if (!p.detail.includes(detail)) p.detail += `<br>${detail}`;
      p.bright ||= bright;
      if (RANK[kind] < RANK[p.kind]) Object.assign(p, { kind, label });
    } else {
      p = { lat, lng, label, detail, kind, bright };
      points.set(key, p);
    }
    if (text) wants.push({ p, text, prio, ref });
  };

  // The home spot comes from GeoIP of the public address, which names the ISP's network, often a
  // hub city away from the house. The card says so, so it isn't read as a precise location.
  if (state.home) addPoint(state.home.lat, state.home.lng, state.home.label, "This machine<br>Placed by your public IP, usually your ISP's nearest hub, not your house", "home", true, `This PC, by IP · ${state.home.label}`, 0);

  /** Draw a hop path from home. `style` picks the look; labels only for the selected route. */
  const drawPath = (name: string, hopsIn: Hop[], style: "sel" | "dim" | "alt" | "relay", labels: boolean): Hop | undefined => {
    const hops = [...hopsIn].sort((a, b) => a.hop - b.hop).filter((h) => h.lat != null && h.lng != null);
    const end = hops.filter((h) => h.source !== "home").pop();
    const segOf = new Map<Hop, Segment>();
    if (style !== "dim") for (const sg of segsOf(hopsIn)) for (const h of sg.hops) segOf.set(h, sg);
    const floors = style !== "dim" ? floorRtts([...hopsIn].sort((a, b) => a.hop - b.hop)) : new Map<number, number>();
    const look = { sel: ["#d0d0d0", 0.08, true], dim: ["#303030", 0.04, false], alt: ["#8a8a8a", 0.11, false], relay: ["#ffffff", 0.14, false] } as const;
    const [color, alt, dash] = look[style];
    if (style === "sel") terrs.push(...territories(hopsIn));
    // Every route leaves from this machine, even when the gateway does not answer.
    let prev: Hop | undefined = state.home ? { hop: 0, ip: null, rtts: [], avg: null, lat: state.home.lat, lng: state.home.lng, place: state.home.label, source: "home" } : undefined;
    let prevSeg: Segment | undefined;
    for (const h of hops) {
      const sg = segOf.get(h);
      const f = floors.get(h.hop);
      const pf = prev ? floors.get(prev.hop) ?? 0 : 0;
      if (prev && (prev.lat !== h.lat || prev.lng !== h.lng)) {
        const add = f != null ? ` · +${Math.max(0, f - pf).toFixed(0)} ms` : h.avg != null ? ` · ${h.avg.toFixed(0)} ms` : "";
        arcs.push({ sLat: prev.lat!, sLng: prev.lng!, eLat: h.lat!, eLng: h.lng!, color, stroke: 0, alt, dash, ms: f != null ? Math.max(0, f - pf) : undefined, label: `<b>${esc(name)}</b> hop ${h.hop}${sg ? ` · ${esc(sg.net.name)}` : ""}<br><span class="m">${esc(prev.place ?? "")} → ${esc(h.place ?? "")}${add}</span>` });
      }
      if (h.source !== "home") {
        // Where the route enters a new network, its label names the network.
        const entering = sg && sg !== prevSeg && sg.net.id !== "home";
        // The route's end card always names its network, so every card on the route reads the same way.
        const kick = entering || (h === end && sg && sg.net.id !== "home");
        const text = labels ? (kick ? `${sg!.net.name} · ${h.place}` : h.place) : undefined;
        addPoint(h.lat!, h.lng!, h.place ?? h.ip ?? "", `${esc(name)} hop ${h.hop}${sg ? ` · ${esc(sg.net.name)}` : ""}${h.avg != null ? ` · ${h.avg.toFixed(0)} ms` : ""}${h.rdns ? `<br>${esc(h.rdns)}` : ""}${h.estimated ? `<br>Location estimated: ${esc(h.estimated)}` : ""}`, "hop", style !== "dim", text, h === end ? 2 : entering ? 2.5 : 3);
      }
      if (sg) prevSeg = sg;
      prev = h;
    }
    return end;
  };

  // The gain map: every region the relay's players reported from, and nothing else.
  if (state.gainMap.open) {
    drawGainMap(addPoint);
    globe.setTerritories(terrs);
    globe.setData(arcs, [...points.values()], wants);
    globe.setRace(null);
    globe.setPulse(null);
    return;
  }

  // The passport: every place the traffic has been stamped, and nothing else.
  if (state.passport.open) {
    drawPassport(addPoint);
    globe.setTerritories(terrs);
    globe.setData(arcs, [...points.values()], wants);
    globe.setRace(null);
    globe.setPulse(null);
    return;
  }

  // The match race: this PC's direct lane and relay lane to the game servers, and nothing else.
  if (state.race.open) {
    const { run, pulse } = drawRace(addPoint, arcs);
    globe.setTerritories(terrs);
    globe.setData(arcs, [...points.values()], wants);
    globe.setRace(run);
    globe.setPulse(pulse);
    return;
  }
  globe.setRace(null);
  globe.setPulse(null);

  // With the proof open, both measured routes are drawn: direct dashed, via the relay solid white.
  if (state.proof.open && state.proof.result) {
    for (const t of state.traces.values()) drawPath(t.target, [...t.hops.values()], "dim", false);
    drawPath("Direct", state.proof.direct, "sel", true);
    const at = state.proof.at;
    if (at && state.proof.relay.length) {
      drawPath(`via ${at.name}`, state.proof.relay, "relay", false);
      const st = state.proof.result.relay ? routeStats(state.proof.result.relay) : undefined;
      addPoint(at.lat, at.lng, at.name, `relay${st?.median != null ? ` · ${st.median.toFixed(0)} ms median to target` : ""}`, "relay", true, at.name, 1);
    }
    globe.setTerritories(terrs);
    globe.setData(arcs, [...points.values()], wants);
    return;
  }
  // With the peak log open, the path picked there is the one drawn and labelled; live traces stay dim.
  const peakPath = selectedPeakPath();
  if (peakPath) {
    for (const t of state.traces.values()) drawPath(t.target, [...t.hops.values()], "dim", false);
    drawPath(`Peak ${pathName(state.peak.selected!)}`, peakPath.hops, "sel", true);
    globe.setTerritories(terrs);
    globe.setData(arcs, [...points.values()], wants);
    return;
  }
  for (const t of state.traces.values()) drawPath(t.target, [...t.hops.values()], t.target === sel ? "sel" : "dim", t.target === sel);

  // An earlier path to the selected destination, picked in the Routes list.
  const selT = selectedTrace();
  const v = selT && state.selectedVariant != null ? selT.variants?.[state.selectedVariant] : undefined;
  if (v) drawPath(`${selT!.target} ${variantName(state.selectedVariant!)}`, v.hops, "alt", true);

  // Best relay route: home → measured path to the relay → destination. The onward leg fades to mark the estimate.
  const drawn = new Set<string>();
  const end = routeEnd(selectedTrace());
  const relay = state.selectedRelay ? state.relayMeasures.get(state.selectedRelay) : undefined;
  if (state.home && end && relay && relay.lat != null && relay.lng != null && relay.total != null) {
    const rt = state.relayTraces.get(RELAY + relay.relay.host);
    const last = rt ? drawPath(`via ${relay.relay.name}`, [...rt.hops.values()].filter((h) => h.source !== "home"), "relay", false) : undefined;
    const from = last && haversineKm(last.lat!, last.lng!, relay.lat, relay.lng) > 30 ? last : state.home;
    if (!last || from === last) arcs.push({ sLat: from.lat!, sLng: from.lng!, eLat: relay.lat, eLng: relay.lng, color: "#ffffff", stroke: 0, alt: 0.14, dash: false, ms: relay.rtt ?? undefined, label: `<b>via ${esc(relay.relay.name)}${tunnelOf(relay.relay) === "on" ? "" : " · preview, not connected"}</b><br><span class="m">${relay.rtt!.toFixed(0)} ms measured to relay</span>` });
    arcs.push({ sLat: relay.lat, sLng: relay.lng, eLat: end.lat, eLng: end.lng, color: ["#ffffff", "rgba(255,255,255,0.3)"], stroke: 0, alt: 0.14, dash: false, ms: relay.legEst ?? undefined, label: `<b>${esc(relay.relay.name)} → ${esc(end.place)}</b><br><span class="m">~${relay.legEst!.toFixed(0)} ms estimated from distance</span>` });
    addPoint(relay.lat, relay.lng, relay.relay.name, `relay · ${relay.rtt!.toFixed(0)} ms from here`, "relay", true, relayCard(relay.relay), 1);
    drawn.add(relay.relay.host);
  }

  // Riot's public NA sites, always on the map as reference points: placed from public information,
  // not measured. Their cards always say "Reference" and show only where there is room.
  for (const l of LANDMARKS) addPoint(l.lat, l.lng, l.place, `Reference point, not measured from this PC<br>${l.detail}`, "hop", false, `Reference · ${l.card}`, 4, true);

  // Every live connection that is not traced yet, as a faint arc to where GeoIP puts its far end,
  // grouped by place. The selected process's arcs are brighter.
  if (state.home) {
    const home = state.home;
    const byPlace = new Map<string, { lat: number; lng: number; place: string; procs: Set<string>; n: number; hl: boolean }>();
    for (const c of state.conns) {
      if (state.traces.has(c.remote_ip)) continue;
      const g = state.geo.get(c.remote_ip);
      if (g?.lat == null || g.lon == null) continue;
      const key = `${g.lat.toFixed(1)},${g.lon.toFixed(1)}`;
      if (key === `${home.lat.toFixed(1)},${home.lng.toFixed(1)}`) continue;
      let e = byPlace.get(key);
      if (!e) byPlace.set(key, (e = { lat: g.lat, lng: g.lon, place: [g.city, g.regionName ?? g.country].filter(Boolean).join(", ") || "Unknown place", procs: new Set(), n: 0, hl: false }));
      e.procs.add(c.process);
      e.n++;
      e.hl ||= c.process === state.selectedProc || c.process === state.hoverProc;
    }
    for (const e of byPlace.values()) {
      const who = [...e.procs].slice(0, 4).map(esc).join(", ") + (e.procs.size > 4 ? ` +${e.procs.size - 4}` : "");
      const what = `${e.n} connection${e.n === 1 ? "" : "s"} · ${who}`;
      arcs.push({ sLat: home.lat, sLng: home.lng, eLat: e.lat, eLng: e.lng, color: e.hl ? "#9a9a9a" : "#4a4a4a", stroke: 0, alt: 0.05, dash: false, label: `<b>${esc(e.place)}</b><br><span class="m">${what} · placed by GeoIP, not traced</span>` });
      addPoint(e.lat, e.lng, e.place, `${what} · not traced yet`, "hop", e.hl);
    }
  }

  // Every located relay stays on the map with its leg from this machine, so it is clear where each
  // relay is and which one the game is playing through (solid white) before any destination is picked.
  if (state.home) {
    for (const m of state.relayMeasures.values()) {
      if (drawn.has(m.relay.host) || m.lat == null || m.lng == null) continue;
      const on = tunnelOf(m.relay) !== "off";
      const ms = m.rtt != null ? `${m.rtt.toFixed(0)} ms from here` : "no reply";
      arcs.push({ sLat: state.home.lat, sLng: state.home.lng, eLat: m.lat, eLng: m.lng, color: on ? "#ffffff" : "#6a6a6a", stroke: 0, alt: 0.14, dash: false, label: `<b>${on ? "Playing on" : "Relay"} ${esc(m.relay.name)}</b><br><span class="m">${ms}</span>` });
      addPoint(m.lat, m.lng, m.relay.name, `relay · ${ms}${on ? " · playing on this relay" : ""}`, "relay", on || m.relay.host === state.selectedRelay, relayCard(m.relay), 1);
    }
  }

  globe.setTerritories(terrs);
  globe.setData(arcs, [...points.values()], wants);
}

type AddPoint = (lat: number, lng: number, label: string, detail: string, kind: NodeKind, bright: boolean, text?: string, prio?: number, ref?: boolean) => void;

/** Thirds of a race lane lit: one per clean match, all three once the path has the matches it needs. */
const raceLit = (n: number, need: number): number => Math.min(3, Math.floor((n * 3) / Math.max(1, need)));

/** The lane a match ran on: direct, the relay lane for a relay, or none when its path is unknown or switched mid-match. */
function laneOf(path: string): RaceLane | null {
  if (path === "direct") return "direct";
  return path !== "unknown" && path !== "mixed" && (allRelays().some((x) => x.name === path) || path === state.race.data?.pick.vs) ? "relay" : null;
}

/** Packet time per measured ms: live at the race's pace, a replay faster so a match plays in a couple of minutes. */
const LIVE_MS_PER_MS = 90;
const REPLAY_MS_PER_MS = 12;

/** The packet a live or replayed match sends down its lane for the line on screen. */
function racePulse(): LanePulse | null {
  const { replay, live, at } = state.race;
  const shown = replay ?? live;
  const lane = shown ? laneOf(shown.path) : null;
  const s = replay ? replay.samples[at] : live?.samples[live.samples.length - 1];
  if (!shown || !lane || !s) return null;
  const w = replay?.worst;
  return {
    lane,
    durMs: s.ms * (replay ? REPLAY_MS_PER_MS : LIVE_MS_PER_MS),
    loss: s.sent ? s.lost / s.sent : 0,
    key: `${shown.id}:${replay ? at : live!.samples.length}`,
    flash: !!w && at >= w.from && at <= w.to && !!replay,
  };
}

/** Bytes a second as a short rate. */
const rateText = (bps: number): string => `${(bps / 1000).toFixed(bps < 9950 ? 1 : 0)} kB/s`;

/**
 * The match race, from the backend's match_race: a direct lane (dashed) and a lane via the relay Auto
 * compares (solid) from this PC to League's NA servers in Chicago, side by side. Each lights a third
 * per clean match on its path. Once both have their matches, the packets race at each path's
 * in-game ms and the winner by the bar lights; under the bar both light, a tie.
 * A live or replayed match takes the lanes over: its own lane lit, the other grey, and one packet
 * per netstats line at that line's ping. A live match through the relay puts the tunnel's byte rate
 * on the relay's box.
 */
function drawRace(addPoint: AddPoint, arcs: ArcDatum[]): { run: RaceRun | null; pulse: LanePulse | null } {
  const r = state.race.data;
  const home = state.home;
  const end = LANDMARKS[0];
  const { replay, live } = state.race;
  const shown = replay ?? live;
  const active = shown ? laneOf(shown.path) : null;
  // A match's own relay, else the one Auto compares.
  const vs = shown && active === "relay" ? shown.path : r?.pick.vs ?? null;
  if (!home || (!r && !shown)) return { run: null, pulse: null };
  const m = r?.pick.matches;
  const counted = (lane: RaceLane) => (lane === "direct" ? m?.direct : vs === r?.pick.vs ? m?.relay : 0) ?? 0;
  const lit = (lane: RaceLane) => (shown ? (lane === active ? 3 : 0) : raceLit(counted(lane), r!.min_matches));
  const label = (lane: RaceLane, name: string) => {
    if (shown) return `<b>${esc(name)}</b><br><span class="m">${lane === active ? `this match's path${replay ? ", replayed" : ", live"}` : "not used in this match"}</span>`;
    const n = counted(lane);
    const ms = lane === "direct" ? m?.direct_ms : m?.relay_ms;
    return `<b>${esc(name)}</b> · ${n} clean match${n === 1 ? "" : "es"} counted<br><span class="m">${ms == null ? "no in-game ping yet" : `${ms.toFixed(1)} ms in game, loss counted`}</span>`;
  };
  addPoint(end.lat, end.lng, end.place, `Reference point, not measured from this PC<br>${end.detail}`, "hop", true, `Reference · ${end.card}`, 2, true);
  arcs.push({ sLat: home.lat, sLng: home.lng, eLat: end.lat, eLng: end.lng, color: "#d0d0d0", stroke: 0, alt: 0, dash: true, race: { lane: "direct", from: 0, to: 1, lit: lit("direct") }, label: label("direct", "Direct") });
  if (vs) {
    const relayLeg = (s: { lat: number; lng: number }, e: { lat: number; lng: number }, from: number, to: number) =>
      arcs.push({ sLat: s.lat, sLng: s.lng, eLat: e.lat, eLng: e.lng, color: "#ffffff", stroke: 0, alt: 0, dash: false, race: { lane: "relay", from, to, lit: lit("relay") }, label: label("relay", `Via ${vs}`) });
    // Through the relay's box when it is located; its lane still ends at the game servers.
    const saved = allRelays().find((x) => x.name === vs);
    const at = saved ? state.relayMeasures.get(saved.host) : undefined;
    if (saved && at?.lat != null && at.lng != null) {
      const a = haversineKm(home.lat, home.lng, at.lat, at.lng);
      const b = haversineKm(at.lat, at.lng, end.lat, end.lng);
      const f = a + b > 0 ? a / (a + b) : 1;
      relayLeg(home, { lat: at.lat, lng: at.lng }, 0, f);
      relayLeg({ lat: at.lat, lng: at.lng }, end, f, 1);
      const rate = live && !replay && live.path === vs ? state.race.rate : undefined;
      const flow = rate ? `Tunnel · ↓ ${rateText(rate.rx)}  ↑ ${rateText(rate.tx)}` : undefined;
      addPoint(at.lat, at.lng, saved.name, `relay${at.rtt != null ? ` · ${at.rtt.toFixed(0)} ms from here` : ""}${flow ? `<br>${esc(flow)}, from this PC's tunnel counters` : ""}`, "relay", true, relayCard(saved), 1);
      if (flow) addPoint(at.lat, at.lng, saved.name, "", "relay", true, flow, 1.5);
    } else relayLeg(home, end, 0, 1);
  }
  if (shown) return { run: null, pulse: racePulse() };
  const kind = r!.verdict.kind;
  if (!vs || kind === "unknown" || m!.direct_ms == null || m!.relay_ms == null) return { run: null, pulse: null };
  return { run: { ms: { direct: m!.direct_ms, relay: m!.relay_ms }, winner: kind === "gain" ? "relay" : kind === "worse" ? "direct" : "tie" }, pulse: null };
}

/**
 * Public, city-level Riot sites for League NA, drawn as reference points: they come from public
 * information, not from a measurement on this PC. The game servers and the exchange where the relay
 * path enters Riot are both in Chicago, so they share one box. The hosts that answer ping for NA
 * sit in Ashburn, Los Angeles and Seattle, which is why ping probes mislead.
 */
const LANDMARKS: { lat: number; lng: number; place: string; card: string; detail: string }[] = [
  { lat: 41.878, lng: -87.63, place: "Chicago, IL", card: "Riot · League NA servers", detail: "League of Legends NA game servers, and the Chicago exchange where a relay path enters Riot Direct" },
  { lat: 39.044, lng: -77.488, place: "Ashburn, VA", card: "Riot Direct · Ashburn", detail: "Riot Direct meets many ISPs here, then carries game traffic to Chicago on its own backbone. Riot hosts here answer ping; the game server does not" },
  { lat: 34.052, lng: -118.244, place: "Los Angeles, CA", card: "Riot Direct · Los Angeles", detail: "Riot Direct site whose hosts answer ping for NA, far from the Chicago game servers" },
  { lat: 47.606, lng: -122.332, place: "Seattle, WA", card: "Riot Direct · Seattle", detail: "Riot Direct site whose hosts answer ping for NA, far from the Chicago game servers" },
];

/** One plate per network along a route, around the places its hops sit; neighbours alternate greys. */
function territories(hops: Hop[]): Territory[] {
  const SHADES = [1, 0.45, 0.75, 0.3];
  const out: Territory[] = [];
  segsOf(hops).forEach((sg, i) => {
    const pts = sg.hops.filter((h) => h.lat != null && h.lng != null).map((h) => [h.lng!, h.lat!] as [number, number]);
    if (!pts.length) return;
    const add = sg.addedMs != null ? ` · +${Math.round(sg.addedMs)} ms` : "";
    const span = sg.first === sg.last ? `hop ${sg.first}` : `hops ${sg.first}–${sg.last}`;
    out.push({ ring: blob(pts, 1.1), shade: SHADES[i % SHADES.length], lift: i, label: `<b>${esc(sg.net.name)}</b>${sg.net.asn ? ` <span class="m">${esc(sg.net.asn)}</span>` : ""}<br><span class="m">${span}${add}</span>` });
  });
  return out;
}

/** A rounded hull around points: a circle of `r` degrees at each, then their convex hull, closed. */
function blob(pts: [number, number][], r: number): [number, number][] {
  const ring: [number, number][] = [];
  for (const [lng, lat] of pts) {
    const k = 1 / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 2 * Math.PI;
      ring.push([lng + r * k * Math.cos(a), lat + r * Math.sin(a)]);
    }
  }
  const p = ring.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  const up: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of [...p].reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  // Clockwise in lng/lat, the winding three-globe reads as "the inside", not the rest of the planet.
  const hull = lo.slice(0, -1).concat(up.slice(0, -1)).reverse();
  return [...hull, hull[0]];
}

/** A relay's map card: "Playing on" for the tunnel's relay while it is on, "Preview" for one picked in a list but not connected. */
function relayCard(r: Relay): string {
  return tunnelOf(r) === "on" ? `Playing on · ${r.name}` : r.host === state.selectedRelay ? `Preview · ${r.name}` : r.name;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------- peak-hour log ----------

const SHAPES = ["circle", "square", "triangle", "diamond", "cross", "ring"] as const;
/** One grey per path, brightest for Path A. Shape tells paths apart; grey only ranks them. */
const GREYS = ["#f4f4f4", "#b4b4b4", "#8a8a8a", "#6a6a6a", "#9a9a9a", "#5a5a5a"];
const pathName = (i: number): string => `Path ${String.fromCharCode(65 + i)}`;

function marker(shape: (typeof SHAPES)[number], x: number, y: number, r: number, fill: string): string {
  switch (shape) {
    case "square":
      return `<rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" fill="${fill}"/>`;
    case "triangle":
      return `<path d="M${x} ${y - r * 1.2}L${x + r * 1.1} ${y + r * 0.8}L${x - r * 1.1} ${y + r * 0.8}Z" fill="${fill}"/>`;
    case "diamond":
      return `<path d="M${x} ${y - r * 1.3}L${x + r * 1.3} ${y}L${x} ${y + r * 1.3}L${x - r * 1.3} ${y}Z" fill="${fill}"/>`;
    case "cross":
      return `<path d="M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}" stroke="${fill}" stroke-width="1.6"/>`;
    case "ring":
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${fill}" stroke-width="1.4"/>`;
    default:
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
  }
}
const swatch = (i: number) => `<svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">${marker(SHAPES[i % SHAPES.length], 0, 0, 3.6, GREYS[i % GREYS.length])}</svg>`;

/** Hops of a sample with places filled in, built once per sample. */
function peakHops(s: PeakSample): Hop[] {
  let hops = state.peak.located.get(s.ts);
  if (!hops) {
    hops = s.hops.map((h) => ({ hop: h.hop, ip: h.ip, rtts: h.rtts, avg: h.avg, rdns: h.rdns }));
    locateHops({ hops: new Map(hops.map((h) => [h.hop, h])) });
    state.peak.located.set(s.ts, hops);
  }
  return hops;
}

async function loadPeak(): Promise<void> {
  try {
    const [samples, status] = await Promise.all([api.call<PeakSample[]>("peak_log"), api.call<PeakStatus>("peak_status")]);
    state.peak.samples = samples;
    state.peak.status = status;
    const ips = [...new Set(samples.flatMap((s) => [s.target, ...s.hops.map((h) => h.ip)]))].filter((ip): ip is string => !!ip && !isPrivateIp(ip) && !state.geo.has(ip));
    if (ips.length) for (const g of await api.call<Geo[]>("geolocate", { ips })) if (g.status === "success") state.geo.set(g.query, g);
  } catch (e) {
    state.peak.error = String(e);
  }
  state.peak.located.clear();
  state.peak.summary = summarize(state.peak.samples, peakHops, keyOf);
  if (state.peak.selected == null || state.peak.selected >= state.peak.summary.paths.length) {
    const best = state.peak.summary.best;
    state.peak.selected = best ? state.peak.summary.paths.indexOf(best) : state.peak.summary.paths.length ? 0 : null;
  }
  renderPeak();
  draw();
  fitPeak();
}

function peakConfig(): PeakConfig {
  return { ...DEFAULT_PEAK, ...(state.config.peak ?? {}) };
}

function fillPeakForm(): void {
  const c = peakConfig();
  $<HTMLInputElement>("peakTarget").value = c.target;
  $<HTMLInputElement>("peakStart").value = c.start;
  $<HTMLInputElement>("peakEnd").value = c.end;
  $<HTMLInputElement>("peakEvery").value = String(c.every_min);
  $<HTMLInputElement>("peakDays").value = String(c.days);
}

function readPeakForm(): PeakConfig {
  return {
    target: $<HTMLInputElement>("peakTarget").value.trim(),
    start: $<HTMLInputElement>("peakStart").value.trim(),
    end: $<HTMLInputElement>("peakEnd").value.trim(),
    every_min: Number($<HTMLInputElement>("peakEvery").value),
    days: Number($<HTMLInputElement>("peakDays").value),
  };
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });
const rangeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const whenFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const dayKey = (ts: number) => new Date(ts).toDateString();

/** Name each path by the networks it crosses and the towns only it passes through. */
function peakPathLabel(paths: PeakPath[], i: number): { chain: string; via: string[] } {
  const towns = paths.map((p) => new Set(viaCities(p.key)));
  const segs = segsOf(paths[i].hops);
  const own = [...towns[i]].filter((x) => towns.some((o, j) => j !== i && !o.has(x)));
  const via = paths.length > 1 && own.length ? own : segs.filter((x) => x.net.id !== "home" && x.to).map((x) => town(x.to!));
  return { chain: netChain(segs) || "unnamed networks", via: [...new Set(via)] };
}

function renderPeak(): void {
  const p = state.peak;
  const sum = p.summary;
  const c = peakConfig();
  const st = p.status;
  const until = c.until ? whenFmt.format(new Date(c.until)) : undefined;
  $("peakState").textContent = p.error
    ? `Log unavailable: ${p.error}`
    : `${st?.scheduled ? `Scheduled: ${c.start}–${c.end} every ${c.every_min} min${until ? ` until ${until}` : ""}.` : "Not scheduled."} ${sum?.samples ?? 0} samples${sum?.failed ? `, ${sum.failed} failed` : ""}.${st?.log_path && !api.mock ? ` Log: ${st.log_path}` : api.mock ? " Replay data." : ""}`;
  $("peakRange").textContent = sum?.from != null ? `${rangeFmt.format(sum.from)} – ${rangeFmt.format(sum.to!)}` : "";
  $("peakRun").textContent = st?.scheduled ? "Restart" : "Start";
  $<HTMLButtonElement>("peakStop").disabled = !st?.scheduled;
  const name = (x: PeakPath) => pathName(sum!.paths.indexOf(x));
  const worth = sum?.gainMs != null && sum.paths.length > 1 && sum.gainMs >= RELAY_WORTH_MS;
  $("peakVerdict").innerHTML = sum ? `${sum.best ? `<span class="chip">${worth ? "relay worth testing" : "relay unlikely to help"}</span>` : ""}${esc(verdict(sum, name))}` : "Loading.";
  renderPeakPaths();
  renderPeakCharts();
}

function renderPeakPaths(): void {
  const el = $("peakPaths");
  const sum = state.peak.summary;
  el.innerHTML = "";
  if (!sum?.paths.length) {
    el.innerHTML = `<div class="empty">No samples yet. Start the schedule, or take one sample now.</div>`;
    return;
  }
  sum.paths.forEach((path, i) => {
    const { chain, via } = peakPathLabel(sum.paths, i);
    const row = document.createElement("div");
    row.className = "r";
    row.setAttribute("aria-selected", String(state.peak.selected === i));
    const best = path === sum.best ? " · best" : "";
    const ms = path.medianMs != null ? `${path.medianMs.toFixed(0)} ms` : "no reply";
    row.innerHTML =
      `<span>${swatch(i)}</span><span class="nm">${pathName(i)}${best}</span><span class="tot">${ms}</span>` +
      `<span class="br">${esc(chain)}${via.length ? ` · via ${via.map(esc).join(", ")}` : ""}</span>` +
      `<span class="br">${(path.share * 100).toFixed(0)}% · ${path.points.length} runs · best ${path.minMs?.toFixed(0) ?? "—"} ms · ${path.medianHops ?? "—"} hops</span>` +
      `<span class="share"><i style="width:${Math.max(2, Math.round(path.share * 100))}%"></i></span>`;
    activatable(row, () => {
      state.peak.selected = i;
      renderPeakPaths();
      renderPeakCharts();
      draw();
      fitPeak();
    });
    el.appendChild(row);
  });
}

interface PeakDot {
  x: number;
  y: number;
  yh: number;
  path: number;
  pt: PeakPoint;
}
let peakDots: PeakDot[] = [];

/**
 * Ping and hop count per sample, one column per sample in time order. Only the peak window is
 * sampled, so a real time axis would be mostly empty: days are marked by dividers instead.
 */
function renderPeakCharts(): void {
  const sum = state.peak.summary;
  const svg = $("peakPing") as unknown as SVGSVGElement;
  const hsvg = $("peakHops") as unknown as SVGSVGElement;
  const W = svg.clientWidth || 600;
  const H = svg.clientHeight || 160;
  const HH = hsvg.clientHeight || 64;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  hsvg.setAttribute("viewBox", `0 0 ${W} ${HH}`);
  const all = (sum?.paths ?? []).flatMap((p, i) => p.points.map((pt) => ({ pt, path: i }))).sort((a, b) => a.pt.ts - b.pt.ts);
  if (!all.length) {
    svg.innerHTML = `<text class="ax" x="0" y="20">Samples appear here.</text>`;
    hsvg.innerHTML = "";
    peakDots = [];
    $("peakPingNote").textContent = "";
    return;
  }
  const L = 30;
  const R = 96; // room for the direct labels on the right
  const T = 8;
  const B = 18;
  const ms = all.map((a) => a.pt.ms).filter((v): v is number => v != null);
  const lo = Math.floor(Math.min(...ms) / 10) * 10;
  const hi = Math.ceil(Math.max(...ms) / 10) * 10 || lo + 10;
  const hlo = Math.min(...all.map((a) => a.pt.hops)) - 1;
  const hhi = Math.max(...all.map((a) => a.pt.hops)) + 1;
  const xOf = (i: number) => L + (all.length === 1 ? (W - L - R) / 2 : (i / (all.length - 1)) * (W - L - R));
  const yOf = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const yhOf = (v: number) => 4 + (1 - (v - hlo) / (hhi - hlo || 1)) * (HH - 8);
  const parts: string[] = [];
  const hparts: string[] = [];
  const step = (hi - lo) / 10 > 4 ? 20 : 10;
  for (let v = lo; v <= hi; v += step) parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${yOf(v)}" y2="${yOf(v)}"/><text class="ax r" x="${L - 6}" y="${yOf(v) + 3}">${v}</text>`);
  // Day dividers and labels.
  let prevDay = "";
  // Day labels are about 40 px wide: skip one that would run into the last one drawn.
  let lastLabelX = -Infinity;
  all.forEach((a, i) => {
    const d = dayKey(a.pt.ts);
    if (d === prevDay) return;
    prevDay = d;
    const x = i ? (xOf(i - 1) + xOf(i)) / 2 : L;
    if (i) {
      parts.push(`<line class="dayline" x1="${x}" x2="${x}" y1="${T}" y2="${H - B}"/>`);
      hparts.push(`<line class="dayline" x1="${x}" x2="${x}" y1="0" y2="${HH}"/>`);
    }
    if (x - lastLabelX < 44) return;
    lastLabelX = x;
    parts.push(`<text class="ax" x="${x + 4}" y="${H - 4}">${esc(dayFmt.format(a.pt.ts))}</text>`);
  });
  // Label the hop counts that occur, at most four, so a label never sits beside an empty row.
  const counts = [...new Set(all.map((a) => a.pt.hops))].sort((a, b) => a - b);
  for (const v of counts.length <= 4 ? counts : [counts[0], counts[counts.length - 1]]) hparts.push(`<text class="ax r" x="${L - 6}" y="${yhOf(v) + 3}">${v}</text>`);
  // Median of every sample, and the best path's median, labelled directly at the right edge.
  const lines: { v: number; cls: string; text: string; b?: boolean }[] = [];
  if (sum!.medianMs != null) lines.push({ v: sum!.medianMs, cls: "medline", text: `median ${sum!.medianMs.toFixed(0)}` });
  if (sum!.best?.medianMs != null && sum!.paths.length > 1) lines.push({ v: sum!.best.medianMs, cls: "bestline", text: `${pathName(sum!.paths.indexOf(sum!.best))} ${sum!.best.medianMs.toFixed(0)}`, b: true });
  for (const l of lines) parts.push(`<line class="${l.cls}" x1="${L}" x2="${W - R}" y1="${yOf(l.v)}" y2="${yOf(l.v)}"/>`);
  // Keep the two labels from overlapping when the medians are close.
  const ly = lines.map((l) => yOf(l.v) + 3);
  if (ly.length === 2 && Math.abs(ly[0] - ly[1]) < 12) {
    const mid = (ly[0] + ly[1]) / 2;
    const up = ly[0] < ly[1] ? 0 : 1;
    ly[up] = mid - 6;
    ly[1 - up] = mid + 6;
  }
  lines.forEach((l, i) => parts.push(`<text class="lbl${l.b ? " b" : ""}" x="${W - R + 6}" y="${ly[i]}">${esc(l.text)}</text>`));
  // Marks: unselected paths first, so the selected one draws on top.
  peakDots = all.map((a, i) => ({ x: xOf(i), y: a.pt.ms != null ? yOf(a.pt.ms) : NaN, yh: yhOf(a.pt.hops), path: a.path, pt: a.pt }));
  const order = [...peakDots].sort((a, b) => Number(a.path === state.peak.selected) - Number(b.path === state.peak.selected));
  const r = all.length > 160 ? 2.4 : 3.2;
  for (const d of order) {
    const sh = SHAPES[d.path % SHAPES.length];
    const fill = GREYS[d.path % GREYS.length];
    const dim = state.peak.selected != null && d.path !== state.peak.selected;
    const g = (s: string) => (dim ? `<g opacity="0.45">${s}</g>` : s);
    if (!Number.isNaN(d.y)) parts.push(g(marker(sh, d.x, d.y, r, fill)));
    hparts.push(g(marker(sh, d.x, d.yh, r * 0.8, fill)));
  }
  parts.push(`<line id="peakCursor" class="cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>`);
  svg.innerHTML = parts.join("");
  hsvg.innerHTML = hparts.join("");
  $("peakPingNote").textContent = `${all.length} traced · one column per sample, peak window only`;
}

function peakHover(e: MouseEvent): void {
  const tip = $("peakTip");
  const svg = $("peakPing") as unknown as SVGSVGElement;
  const cursor = svg.querySelector("#peakCursor");
  if (!peakDots.length) return;
  const box = svg.getBoundingClientRect();
  const x = ((e.clientX - box.left) / box.width) * (svg.viewBox.baseVal.width || box.width);
  let best = peakDots[0];
  for (const d of peakDots) if (Math.abs(d.x - x) < Math.abs(best.x - x)) best = d;
  if (Math.abs(best.x - x) > 24) {
    tip.hidden = true;
    cursor?.setAttribute("visibility", "hidden");
    return;
  }
  cursor?.setAttribute("x1", String(best.x));
  cursor?.setAttribute("x2", String(best.x));
  cursor?.setAttribute("visibility", "visible");
  tip.innerHTML = `<b>${pathName(best.path)}</b> · ${esc(dayFmt.format(best.pt.ts))} ${esc(timeFmt.format(best.pt.ts))}<br><span class="m">${best.pt.ms != null ? `${best.pt.ms.toFixed(0)} ms` : "no ping reply"} · ${best.pt.hops} hops</span>`;
  tip.hidden = false;
  const host = $("peakCharts").getBoundingClientRect();
  const left = box.left - host.left + (best.x / (svg.viewBox.baseVal.width || box.width)) * box.width;
  tip.style.left = `${Math.min(host.width - tip.offsetWidth - 4, Math.max(4, left + 10))}px`;
  tip.style.top = `${Math.max(4, e.clientY - host.top - tip.offsetHeight - 10)}px`;
}

const selectedPeakPath = (): PeakPath | undefined => (state.peak.open && state.peak.selected != null ? state.peak.summary?.paths[state.peak.selected] : undefined);

function fitPeak(): void {
  const p = selectedPeakPath();
  if (p) globe.fitPoints(routePoints({ hops: new Map(p.hops.map((h) => [h.hop, h])) }));
}

function togglePeak(open = !state.peak.open): void {
  if (open && state.gainMap.open) toggleGainMap(false);
  if (open && state.proof.open) toggleProof(false);
  if (open && state.race.open) toggleRace(false);
  if (open && state.passport.open) togglePassport(false);
  state.peak.open = open;
  $("peak").hidden = !open;
  $("stage").classList.toggle("peak-open", open);
  $("viewPeak").setAttribute("aria-pressed", String(open));
  if (open) {
    fillPeakForm();
    void loadPeak();
  } else draw();
}

async function startPeak(): Promise<void> {
  const cfg = readPeakForm();
  const plan = planSchedule(cfg, new Date());
  if (typeof plan === "string") {
    $("peakState").textContent = plan;
    return;
  }
  try {
    await api.call("peak_schedule", { plan });
    state.config.peak = { ...cfg, until: plan.end_boundary };
    await saveConfig();
    $("peakState").textContent = "Scheduled. Taking a first sample now.";
    await api.call("peak_sample_now", { target: cfg.target });
  } catch (e) {
    $("peakState").textContent = `Could not schedule: ${String(e)}`;
    return;
  }
  await loadPeak();
}

function wirePeak(): void {
  $("viewPeak").addEventListener("click", () => togglePeak());
  $<HTMLFormElement>("peakForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void startPeak();
  });
  $("peakStop").addEventListener("click", async () => {
    try {
      await api.call("peak_unschedule");
    } catch (e) {
      $("peakState").textContent = `Could not stop: ${String(e)}`;
      return;
    }
    await loadPeak();
  });
  $("peakNow").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("peakNow");
    btn.disabled = true;
    $("peakState").textContent = "Tracing and pinging the target. This takes up to a minute.";
    try {
      await api.call("peak_sample_now", { target: readPeakForm().target || peakConfig().target });
    } catch (e) {
      $("peakState").textContent = `Sample failed: ${String(e)}`;
    }
    btn.disabled = false;
    await loadPeak();
  });
  $("peakPing").addEventListener("mousemove", peakHover);
  $("peakPing").addEventListener("mouseleave", () => {
    $("peakTip").hidden = true;
    $("peakPing").querySelector("#peakCursor")?.setAttribute("visibility", "hidden");
  });
  new ResizeObserver(() => state.peak.open && renderPeakCharts()).observe($("peakCharts"));
}

// ---------- relay proof ----------

const fmtMs = (v: number | undefined) => (v == null ? "—" : `${v.toFixed(v < 10 ? 1 : 0)} ms`);
const fmtPct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.01 ? 1 : 0)}%`;

/** Hops with places, the relay's tunnel hop placed at the relay. */
function proofHops(m: RelayComparison["direct"] | null, relayAt?: { lat: number; lng: number; name: string }): Hop[] {
  if (!m) return [];
  const hops: Hop[] = m.hops.map((h) => ({ hop: h.hop, ip: h.ip, rtts: h.rtts, avg: h.avg, rdns: h.rdns }));
  locateHops({ hops: new Map(hops.map((h) => [h.hop, h])) });
  if (!relayAt) return hops;
  const relayHop = hops.find((h) => h.ip && RELAY_NET.test(h.ip));
  if (!relayHop) return hops;
  Object.assign(relayHop, { lat: relayAt.lat, lng: relayAt.lng, place: relayAt.name, source: "geo", estimated: undefined, implausible: undefined });
  // Past the relay, the tunnel's delay covers the trip from home, so a place is checked against
  // the time added after the relay, measured from the relay.
  const relayMs = minRtt(relayHop.rtts) ?? 0;
  for (const h of hops) {
    if (h.hop <= relayHop.hop || !h.ip || !h.implausible) continue;
    const g = state.geo.get(h.ip);
    const p = h.rdns ? placeFromRdns(h.rdns) : undefined;
    const c = p ? { lat: p.lat, lng: p.lng, place: p.name, source: "rdns" as const } : g?.lat != null && g.lon != null ? { lat: g.lat, lng: g.lon, place: geoPlace(g, h.ip), source: "geo" as const } : undefined;
    const best = minRtt(h.rtts);
    if (c && best != null && plausibleForRtt(relayAt.lat, relayAt.lng, c.lat, c.lng, best - relayMs, REALISTIC)) Object.assign(h, c, { implausible: undefined });
  }
  return hops;
}

function proofTarget(): string {
  return selectedIp() ?? state.config.peak?.target ?? DEFAULT_PEAK.target;
}

/** The Relay section, so other panels can ask it to re-read the tunnel's state. */
let relayUi: RelayUi | undefined;
/** The Billing section, re-read when the relay list or the tunnel's relay changes. */
let billingUi: BillingUi | undefined;


/** Notes the path while a match runs and reads League's own ping once it ends. */
async function ingestMatches(): Promise<void> {
  try {
    const r = await api.call<{ added: MatchPing[]; last: MatchPing | null }>("match_ingest");
    state.lastMatch = r.last;
    renderPathChip();
    if (r.added.length) {
      void loadRace();
      void readProofLog().then(renderProof);
      // A new match can change this device's gain, so it goes to the relay's table now.
      void loadRelayGain(true);
      if (state.gainMap.open) void loadGainMap(true);
    }
  } catch {
    /* no League install or logs: nothing to show */
  }
}

async function runProof(): Promise<void> {
  if (state.proof.running) return;
  const target = $<HTMLInputElement>("proofTarget").value.trim();
  const pings = Number($<HTMLInputElement>("proofPings").value) || 50;
  if (!target) return;
  Object.assign(state.proof, { running: true, progress: undefined, error: undefined });
  renderProof();
  try {
    const r = await api.call<RelayComparison>("relay_compare", { target, pings });
    const ips = [...new Set([r.target, r.relay_host, ...r.direct.hops.map((h) => h.ip), ...(r.relay?.hops ?? []).map((h) => h.ip)])].filter((ip): ip is string => !!ip && !isPrivateIp(ip) && !state.geo.has(ip));
    if (ips.length) for (const g of await api.call<Geo[]>("geolocate", { ips })) if (g.status === "success") state.geo.set(g.query, g);
    const cfg = allRelays().find((x) => x.host === r.relay_host);
    const g = state.geo.get(r.relay_host);
    const lat = cfg?.lat ?? g?.lat ?? undefined;
    const lng = cfg?.lng ?? g?.lon ?? undefined;
    state.proof.at = lat != null && lng != null ? { lat, lng, name: cfg?.name ?? `Relay · ${g ? geoPlace(g, r.relay_host) : r.relay_host}` } : undefined;
    state.proof.result = r;
    state.proof.direct = proofHops(r.direct);
    state.proof.relay = proofHops(r.relay, state.proof.at);
    state.proof.viewing = null;
    // The backend judged and saved the run; read the log back so history and months include it.
    if (r.log_error) state.proof.error = `Measured, but the record was not saved: ${r.log_error}`;
    await readProofLog();
  } catch (e) {
    state.proof.error = String(e);
  }
  state.proof.running = false;
  state.proof.progress = undefined;
  // A comparison that failed may have found the tunnel down: show the Relay section's real state.
  if (state.proof.error || state.proof.result?.error) void relayUi?.refresh().catch(() => {});
  renderProof();
  draw();
  fitProof();
}

function fitProof(): void {
  const pts = [...routePoints({ hops: new Map(state.proof.direct.map((h) => [h.hop, h])) }), ...state.proof.relay.filter((h) => h.lat != null).map((h) => ({ lat: h.lat!, lng: h.lng! }))];
  if (state.proof.at) pts.push(state.proof.at);
  globe.fitPoints(pts);
}

// The proof log: one record per run, the data the refund rule reads. Only the backend writes it,
// and it returns every verdict and the month rule with it, so the UI judges nothing itself.
let proofLoading: Promise<void> | undefined;

/** One load at a time when boot and Proof both ask. */
function loadProofLog(): Promise<void> {
  return (proofLoading ??= readProofLog().finally(() => (proofLoading = undefined)));
}

async function readProofLog(): Promise<void> {
  try {
    const h = await api.call<ProofHistory>("proof_history", { tzOffsetMin: new Date().getTimezoneOffset() });
    Object.assign(state.proof, { log: h.records, months: h.months, recent: h.recent, logError: false });
  } catch {
    state.proof.logError = true;
  }
  state.proof.loaded = true;
}

/**
 * This month's refund verdict card. Billing shows it beside the refund it decides; the Relay
 * section leaves it out, and every month's verdict stays in the Proof drawer's history.
 * Markup only: the card's look is styled with the sidebar.
 */
let relayMonthEl: HTMLElement | null = null;

function mountRelayMonth(): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.id = "relayMonth";
  el.className = "relay-month";
  el.title = "Open the relay proof";
  el.addEventListener("click", () => toggleProof(true));
  relayMonthEl = el;
  void loadProofLog().then(renderRelayMonth);
  // "This month" rolls over at midnight on the 1st, also while the app sits in the background.
  setInterval(renderRelayMonth, 60000);
  window.addEventListener("focus", renderRelayMonth);
  return el;
}

function renderRelayMonth(): void {
  const el = relayMonthEl;
  if (!el) return;
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (!state.proof.loaded) {
    el.dataset.verdict = "loading";
    el.textContent = "This month: reading the proof log.";
    return;
  }
  if (state.proof.logError) {
    el.dataset.verdict = "unavailable";
    el.textContent = "This month: the proof log could not be read, so no verdict is shown.";
    return;
  }
  const m = state.proof.months.find((x) => x.month === key);
  el.dataset.verdict = m?.gained ? "gain" : "refund";
  el.innerHTML = m
    ? `<span class="chip${m.gained ? " fill" : ""}">${m.gained ? "Gain" : "Refund"}</span> This month: ${esc(m.text)}`
    : `<span class="chip">Refund</span> This month: no comparisons yet, so no gain shown. Run one in Proof.`;
}

// What players on this ISP network measured with the tunnel's relay, from the relay's gain table.
// The backend sends this device's in-game gain with each fetch and words the line, so the UI only shows it.
let gainLoading: Promise<void> = Promise.resolve();

/** One call at a time: a refresh asked for during a load runs after it. */
function loadRelayGain(refresh: boolean): Promise<void> {
  return (gainLoading = gainLoading.then(() =>
    api.call<GainView | null>("relay_gain", { refresh }).then(renderRelayGain, () => renderRelayGain(null)),
  ));
}

function mountRelayGain(): void {
  const el = document.createElement("p");
  el.id = "relayGain";
  el.className = "relay-gain";
  el.hidden = true;
  el.title = "From the relay's gain table. Rig Doctor sends the relay your ISP network number, region and match pings, never your address.";
  document.getElementById("relay")!.append(el);
  void loadRelayGain(false);
}

/** Hidden when the tunnel's relay has no API (imported from a file) or the table can't be read. */
function renderRelayGain(v: GainView | null): void {
  const el = document.getElementById("relayGain");
  if (!el) return;
  el.hidden = !v;
  if (!v) return;
  el.dataset.kind = v.kind;
  el.textContent = v.text;
}

const VERDICT_CHIP: Record<ProofVerdict["kind"], string> = { gain: "Gain", none: "No gain", worse: "Slower", unknown: "No verdict" };

function renderProofHistory(): void {
  renderRelayMonth();
  const log = state.proof.log;
  const sum = state.proof.recent;
  $("proofHistSum").textContent = sum?.runs
    ? `30 days · ${sum.gains} of ${sum.judged} gained${sum.medianSavedMs != null ? ` · median ${sum.medianSavedMs >= 0 ? "−" : "+"}${Math.abs(sum.medianSavedMs).toFixed(0)} ms` : ""}`
    : "";
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  $("proofMonths").innerHTML = state.proof.months
    .slice(0, 3)
    .map((m) => {
      const [y, mo] = m.month.split("-").map(Number);
      return `<div class="m ${m.gained ? "gain" : "refund"}"><b>${esc(monthFmt.format(new Date(y, mo - 1, 1)))}</b><span class="chip">${m.gained ? "Gain" : "Refund"}</span><div>${esc(m.text)}</div></div>`;
    })
    .join("");
  const latest = log.length - 1;
  const shown = state.proof.viewing ?? (log.length ? latest : null);
  $("proofHist").innerHTML = log.length
    ? log
        .map((rec, i) => ({ rec, i }))
        .reverse()
        .slice(0, 60)
        .map(({ rec: { record: rec, verdict }, i }) => {
          const saved = verdict.saved_ms == null ? "—" : `${verdict.saved_ms >= 0 ? "−" : "+"}${Math.abs(verdict.saved_ms).toFixed(0)} ms`;
          return `<div class="r" role="option" tabindex="0" data-i="${i}" aria-selected="${i === shown}"><span class="nm">${esc(whenFmt.format(new Date(rec.ts)))}</span><span class="tot">${saved}</span><span></span><span class="br">${VERDICT_CHIP[verdict.kind]} · ${rec.source === "auto" ? "Auto · " : ""}${esc(rec.target)}</span></div>`;
        })
        .join("")
    : `<div class="empty">Each comparison you run is kept here.</div>`;
}

function renderProof(): void {
  const p = state.proof;
  const btn = $<HTMLButtonElement>("proofRun");
  btn.disabled = p.running;
  btn.textContent = p.running ? "Measuring" : p.result ? "Run again" : "Run comparison";
  const prog = p.progress;
  $("proofState").textContent = p.running
    ? prog
      ? `Measuring the ${prog.phase === "direct" ? "direct route" : "relay route"}: ${prog.done} of ${prog.total} pings.`
      : "Starting."
    : p.error
      ? `Comparison failed: ${p.error}`
      : "Both routes are measured to the same server, one after the other. Nothing is estimated.";
  const r = p.result;
  // With no run this session, the newest saved run is shown.
  const rec = p.viewing != null ? p.log[p.viewing] : !r && !p.running && p.log.length ? p.log[p.log.length - 1] : undefined;
  const verdictEl = $("proofVerdict");
  const body = $("proofBody");
  renderProofHistory();
  if (!r && !rec) {
    verdictEl.className = "peak-verdict unknown";
    verdictEl.innerHTML = p.running ? "Measuring both routes. The verdict appears when both are done." : "No comparison yet. Run one to see what the relay changes, measured, before you pay for it.";
    body.hidden = !p.log.length;
    $("proofTable").hidden = true;
    $("proofDist").hidden = true;
    $("proofWhen").textContent = "";
    return;
  }
  body.hidden = false;
  $("proofTable").hidden = false;
  $("proofDist").hidden = false;
  let d: RouteStats;
  let rs: RouteStats | undefined;
  let v: ProofVerdict;
  // Set when the run was judged on League's in-game ping: then only that one number is shown.
  let inGame: { direct: number; relay: number } | undefined;
  if (rec) {
    $("proofWhen").textContent = `${rec.record.target} · ${whenFmt.format(new Date(rec.record.ts))} · saved ${rec.record.source === "auto" ? "Auto " : ""}run`;
    inGame = rec.record.matches;
    d = unstore(rec.record.direct);
    rs = rec.record.relay ? unstore(rec.record.relay) : undefined;
    v = rec.verdict;
  } else if (r!.record) {
    // A fresh run shows the numbers and verdict exactly as the backend saved them.
    $("proofWhen").textContent = `${r!.target}${p.at ? ` · ${p.at.name}` : ""} · ${whenFmt.format(new Date(r!.finished_at))}`;
    d = unstore(r!.record.record.direct);
    inGame = r!.record.record.matches;
    rs = r!.record.record.relay ? unstore(r!.record.record.relay) : undefined;
    v = r!.record.verdict;
  } else {
    $("proofWhen").textContent = `${r!.target}${p.at ? ` · ${p.at.name}` : ""} · ${whenFmt.format(new Date(r!.finished_at))}`;
    d = routeStats(r!.direct);
    rs = r!.relay ? routeStats(r!.relay) : undefined;
    v = { kind: "unknown", saved_ms: null, text: r!.error ?? "No verdict: the run was not judged." };
  }
  verdictEl.className = `peak-verdict ${v.kind}`;
  // Named scope, so this run's verdict never reads as a contradiction of the month's verdict.
  verdictEl.innerHTML = `<span class="chip">${VERDICT_CHIP[v.kind]}</span>${rec ? "This saved run" : "This run"}: ${esc(v.text)}`;
  // Lower is better for every row. Change is relay minus direct.
  const rows: [string, (s: RouteStats) => number | undefined, (v: number) => string, boolean?][] = [
    ["Median", (s) => s.median, (x) => fmtMs(x), true],
    ["p90", (s) => s.p90, (x) => fmtMs(x)],
    ["Best", (s) => s.min, (x) => fmtMs(x)],
    ["Jitter", (s) => s.jitter, (x) => fmtMs(x)],
    ["Loss", (s) => s.loss, fmtPct],
    ["Hops", (s) => s.hops, (x) => String(x)],
  ];
  if (inGame) rows.splice(0, rows.length, ["In game", (s) => s.median, (x) => fmtMs(x), true]);
  $("proofRows").innerHTML = rows
    .map(([name, get, fmt, lead]) => {
      const a = get(d);
      const b = rs ? get(rs) : undefined;
      const delta = a != null && b != null ? b - a : undefined;
      const dTxt = delta == null ? "—" : name === "Loss" ? `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${fmtPct(Math.abs(delta))}` : name === "Hops" ? `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)}` : `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${fmtMs(Math.abs(delta))}`;
      const better = delta != null && delta < 0 && (name === "Loss" ? delta <= -0.01 : name === "Hops" ? false : delta <= -1);
      return `<tr${lead ? ' class="lead"' : ""}><td>${name}</td><td>${a == null ? "—" : fmt(a)}</td><td>${b == null ? "—" : fmt(b)}</td><td class="d${better ? " better" : ""}">${dTxt}</td></tr>`;
    })
    .join("");
  $("proofTable").title = "Hops through the relay count the tunnel as one hop.";
  $("proofStripNote").hidden = !rec;
  $("proofStrip").style.display = rec ? "none" : "";
  if (rec) {
    ($("proofStrip") as unknown as SVGSVGElement).innerHTML = "";
    $("proofLost").textContent = inGame
      ? `${inGame.direct} direct and ${inGame.relay} relay matches, loss counted in the score`
      : `direct ${rec.record.direct.sent - rec.record.direct.received} lost${rec.record.relay ? ` · relay ${rec.record.relay.sent - rec.record.relay.received} lost` : ""}`;
  } else renderProofStrip(r!);
}

/** One row of dots per route on a shared ms axis, median marked. Lost pings are counted, not drawn. */
function renderProofStrip(r: RelayComparison): void {
  const svg = $("proofStrip") as unknown as SVGSVGElement;
  const W = svg.clientWidth || 400;
  const H = svg.clientHeight || 120;
  const routes = [
    { name: "Direct", m: r.direct, cls: "" },
    ...(r.relay ? [{ name: "Relay", m: r.relay, cls: "r" }] : []),
  ];
  const all = routes.flatMap((x) => x.m.rtts.filter((v): v is number => v != null));
  $("proofLost").textContent = routes.map((x) => `${x.name.toLowerCase()} ${x.m.rtts.filter((v) => v == null).length} lost`).join(" · ");
  if (!all.length) {
    svg.innerHTML = "";
    return;
  }
  const lo = Math.max(0, Math.floor((Math.min(...all) - 2) / 5) * 5);
  const hi = Math.ceil((Math.max(...all) + 2) / 5) * 5;
  const L = 52;
  const R = 8;
  const x = (v: number) => L + ((v - lo) / (hi - lo || 1)) * (W - L - R);
  const rowH = (H - 18) / routes.length;
  const step = Math.max(5, Math.ceil((hi - lo) / 8 / 5) * 5);
  let out = "";
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="0" y2="${H - 16}"/><text class="ax" x="${x(t)}" y="${H - 3}" text-anchor="middle">${t}</text>`;
  routes.forEach((ro, i) => {
    const cy = i * rowH + rowH / 2;
    const st = routeStats(ro.m);
    out += `<text class="ax" x="0" y="${cy + 3}">${ro.name}</text>`;
    let seed = 17 + i;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (const v of ro.m.rtts) if (v != null) out += `<circle class="pdot ${ro.cls}" cx="${x(v).toFixed(1)}" cy="${(cy + (rnd() - 0.5) * rowH * 0.5).toFixed(1)}" r="2"/>`;
    if (st.median != null) out += `<line class="pmed" x1="${x(st.median)}" x2="${x(st.median)}" y1="${cy - rowH * 0.36}" y2="${cy + rowH * 0.36}"/><text class="lbl b" x="${x(st.median) + 4}" y="${cy - rowH * 0.36 + 8}">${st.median.toFixed(0)}</text>`;
  });
  svg.innerHTML = out;
}

function toggleProof(open = !state.proof.open): void {
  if (open && state.gainMap.open) toggleGainMap(false);
  if (open && state.peak.open) togglePeak(false);
  if (open && state.race.open) toggleRace(false);
  if (open && state.passport.open) togglePassport(false);
  state.proof.open = open;
  $("proof").hidden = !open;
  $("stage").classList.toggle("proof-open", open);
  $("viewProof").setAttribute("aria-pressed", String(open));
  if (open) {
    const input = $<HTMLInputElement>("proofTarget");
    if (!state.proof.running) input.value = state.proof.result?.target ?? proofTarget();
    renderProof();
    if (state.proof.result) fitProof();
    void loadProofLog().then(renderProof);
  }
  draw();
}

function wireProof(): void {
  $("viewProof").addEventListener("click", () => toggleProof());
  $<HTMLFormElement>("proofForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void runProof();
  });
  const pick = (el: HTMLElement | null) => {
    if (!el?.dataset.i) return;
    const i = Number(el.dataset.i);
    // The newest row is the run on screen when this session made it.
    state.proof.viewing = state.proof.result && state.proof.log[i].record.ts === state.proof.result.finished_at && i === state.proof.log.length - 1 ? null : i;
    renderProof();
  };
  $("proofHist").addEventListener("click", (e) => pick((e.target as HTMLElement).closest<HTMLElement>(".r[data-i]")));
  $("proofHist").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    pick((e.target as HTMLElement).closest<HTMLElement>(".r[data-i]"));
  });
  api.on<CompareProgress>("compare:progress", (ev) => {
    if (!state.proof.running) return;
    state.proof.progress = ev;
    renderProof();
  });
  new ResizeObserver(() => state.proof.open && state.proof.result && state.proof.viewing == null && renderProofStrip(state.proof.result)).observe($("proofStrip") as unknown as Element);
}

// ---------- match race ----------

/** Reads the race as the match log stands. No League logs or relay list leaves nothing to race. */
async function loadRace(): Promise<void> {
  try {
    state.race.data = await api.call<MatchRace>("match_race");
  } catch {
    state.race.data = undefined;
  }
  renderRaceKey();
  if (state.race.open) draw();
}

const RACE_CHIP: Record<ProofVerdict["kind"], string> = { gain: "Relay faster", worse: "Direct faster", none: "Tie", unknown: "Needs matches" };

/** A game clock in seconds as m:ss. */
const clockText = (t: number): string => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** A netstats line's game clock as m:ss. Lines without one count 10 s each. */
const clockOf = (s: NetSample | undefined, i: number): string => clockText(s?.t ?? (i + 1) * 10);

/** A death this far over the match's median came with lag: the 10 ms bar Auto and the refund use. */
const LAG_BAR_MS = RELAY_WORTH_MS;

/** What the replay says about the player's deaths: how many came with lag, and the highest ping at one. */
function deathsFoot(deaths: Death[] | null, median: number): string {
  if (!deaths) return "Deaths weren't read for this match. The app has to be open while you play.";
  if (!deaths.length) return "No deaths read in this match.";
  const count = `${deaths.length} death${deaths.length === 1 ? "" : "s"} read`;
  const read = deaths.filter((k): k is Death & { ms: number } => k.ms != null);
  if (!read.length) return `${count}, none close to a netstats line.`;
  const top = read.reduce((a, k) => (k.ms > a.ms ? k : a));
  const over = read.filter((k) => k.ms - median >= LAG_BAR_MS).length;
  return `${count}, ${over || "none"} at ${LAG_BAR_MS} ms or more over the match's ${median.toFixed(1)}. Highest: died at ${clockText(top.t)} at ${top.ms.toFixed(1)} ms.`;
}

const pathText = (path: string): string => (path === "direct" ? "Direct" : path === "unknown" ? "Path unknown" : path === "mixed" ? "Switched mid-match" : `Via ${path}`);

/**
 * A match's ping line by line, as an SVG: the line breaks where the game lost packets (a tick marks
 * each such line), the match median dashed, and for a replay its worst minute shaded, a cursor and
 * a cross on the line at each death.
 */
function matchChart(s: NetSample[], median: number | null, worst?: MatchSeries["worst"], deaths?: Death[] | null): string {
  const W = 316;
  const H = 54;
  if (!s.length) return `<svg class="race-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  const ms = s.map((x) => x.ms);
  const lo = Math.floor(Math.min(...ms) - 2);
  const hi = Math.ceil(Math.max(...ms) + 2);
  const x = (i: number) => (s.length === 1 ? W / 2 : (i / (s.length - 1)) * W);
  const y = (v: number) => 3 + (1 - (v - lo) / (hi - lo || 1)) * (H - 10);
  let d = "";
  let open = false;
  s.forEach((p, i) => {
    if (p.lost > 0) return void (open = false);
    d += `${open ? "L" : "M"}${x(i).toFixed(1)} ${y(p.ms).toFixed(1)}`;
    open = true;
  });
  const lost = s.map((p, i) => (p.lost > 0 ? `<line class="loss" x1="${x(i)}" x2="${x(i)}" y1="${H - 5}" y2="${H}"/>` : "")).join("");
  const band = worst ? `<rect class="worst" x="${x(worst.from)}" y="0" width="${Math.max(2, x(worst.to) - x(worst.from))}" height="${H}"/>` : "";
  const med = median != null ? `<line class="medline" x1="0" x2="${W}" y1="${y(median)}" y2="${y(median)}"/>` : "";
  const cursor = worst !== undefined ? `<line class="cursor" data-r="cursor" x1="0" x2="0" y1="0" y2="${H}"/>` : "";
  const died = (deaths ?? []).map((k) => (k.at == null || k.ms == null ? "" : `<path class="died" d="M${(x(k.at) - 3.5).toFixed(1)} ${(y(k.ms) - 3.5).toFixed(1)}l7 7m0-7l-7 7"/>`)).join("");
  return `<svg class="race-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Ping each 10 s, ${lo} to ${hi} ms">${band}${med}<path class="ping" d="${d}"/>${lost}${died}${cursor}</svg>`;
}

/**
 * The key in the legend's corner. Race: each lane's in-game ms, its thirds lit and the backend's
 * verdict. Live: the running match's ping now, its line so far and the tunnel's byte rate. Replay: a
 * finished match to scrub or play, its worst minute shaded and named.
 */
function renderRaceKey(): void {
  const el = $("raceKey");
  el.hidden = !state.race.open;
  if (!state.race.open) return;
  const { data: r, live, replayOf } = state.race;
  const head = (title: string, chip: string, fill = false, close = false) =>
    `<div class="label"><span>${title}</span>${chip ? `<span class="chip${fill ? " fill" : ""}">${esc(chip)}</span>` : ""}${close ? `<button class="x" type="button" data-act="close" aria-label="Close the replay">×</button>` : ""}</div>`;
  const replayBtn = `<button class="btn tiny" type="button" data-act="replay">Replay last match</button>`;
  // Re-read on every focus and live read: only a change is written, so a screen reader hears only
  // news, and a focused button keeps the focus.
  const show = (html: string) => {
    if (el.dataset.html === html) return;
    const act = (document.activeElement as HTMLElement | null)?.closest?.("#raceKey [data-act]")?.getAttribute("data-act");
    el.innerHTML = el.dataset.html = html;
    if (act) el.querySelector<HTMLElement>(`[data-act="${act}"]`)?.focus();
  };
  if (replayOf != null) {
    const m = state.race.log[replayOf];
    const rp = state.race.replay;
    const when = m ? whenFmt.format(new Date(m.id.slice(0, 10) + "T" + m.id.slice(11).replace(/-/g, ":"))) : "";
    const nav = `<div class="race-nav"><button class="btn tiny" type="button" data-act="older" aria-label="Older match"${replayOf >= state.race.log.length - 1 ? " disabled" : ""}>‹</button><span>${esc(when)}${m ? ` · ${esc(pathText(m.path))} · ${Math.round(m.duration_s / 60)} min` : ""}</span><button class="btn tiny" type="button" data-act="newer" aria-label="Newer match"${replayOf <= 0 ? " disabled" : ""}>›</button></div>`;
    if (!rp || !m) return show(head("Match replay", "", false, true) + nav + `<div class="foot">${esc(state.race.error ?? "Reading the match.")}</div>`);
    const w = rp.worst;
    const worst = w ? `Worst minute ${clockOf(rp.samples[w.from], w.from)}–${clockOf(rp.samples[w.to], w.to)}: ${w.ms.toFixed(1)} ms, ${(w.ms - m.median_ms).toFixed(1)} over the match's ${m.median_ms.toFixed(1)}${w.lost ? `, ${w.lost} packets lost` : ""}. It flashes when the cursor is in it.` : "Under a minute of lines, so no worst minute.";
    // A button per death, jumping the cursor there. Those over the bar stand out.
    const deathBtns = rp.deaths?.length
      ? `<div class="race-deaths" role="group" aria-label="Deaths in this match">${rp.deaths
          .map((k, n) => {
            const ms = k.ms == null ? "no reading" : `${k.ms.toFixed(0)} ms`;
            const over = k.ms != null && k.ms - m.median_ms >= LAG_BAR_MS;
            return `<button class="btn tiny${over ? " over" : ""}" type="button" data-act="death" data-i="${n}" aria-label="Died at ${clockText(k.t)}, ${ms}"${k.at == null ? " disabled" : ""}>${clockText(k.t)} · ${ms}</button>`;
          })
          .join("")}</div>`
      : "";
    show(
      head("Match replay", pathText(m.path), false, true) +
        nav +
        matchChart(rp.samples, m.median_ms, w, rp.deaths) +
        `<div class="race-ctl"><button class="btn tiny" type="button" data-act="play" aria-pressed="false">Play</button><input type="range" data-r="scrub" min="0" max="${Math.max(0, rp.samples.length - 1)}" step="1" value="0" aria-label="Moment in the match" /><span class="num" data-r="now"></span></div>` +
        deathBtns +
        `<div class="foot">${esc(worst)}</div>` +
        `<div class="foot">${esc(deathsFoot(rp.deaths, m.median_ms))}</div>`,
    );
    return syncReplay();
  }
  if (live) {
    const s = live.samples;
    const last = s[s.length - 1];
    const sorted = s.map((x) => x.ms).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
    const lost = s.reduce((a, x) => a + x.lost, 0);
    const sent = s.reduce((a, x) => a + x.sent, 0);
    const rate = state.race.rate;
    const tunnel = live.path !== "direct" && live.tunnel_rx != null && live.tunnel_tx != null ? `<div class="foot">Tunnel ${rate ? `↓ ${rateText(rate.rx)}  ↑ ${rateText(rate.tx)} now, ` : ""}${(live.tunnel_rx / 1e6).toFixed(1)} MB in and ${(live.tunnel_tx / 1e6).toFixed(1)} MB out since it came up, from this PC's counters.</div>` : "";
    return show(
      head("Live match", pathText(live.path)) +
        `<div class="race-live"><span class="ms">${last ? `${last.ms.toFixed(1)}<small>ms</small>` : "—"}</span><span>${last ? `now, ${clockOf(last, s.length - 1)} in · median ${median!.toFixed(1)} · ${lost ? `${lost} of ${sent} packets lost` : "no loss"}` : "Waiting for the game's first 10 s line."}</span></div>` +
        matchChart(s, median) +
        tunnel +
        `<div class="race-ctl">${replayBtn}</div>`,
    );
  }
  const chips = (c: string, fill = false) => head("Match race", c, fill);
  if (!r || !state.home) return show(`${chips("")}<div class="foot">${r ? "Locating this PC." : "No League match read yet. Each finished match lights a third of its path's lane."}</div>`);
  const m = r.pick.matches;
  const row = (sw: "now" | "best", name: string, n: number, ms: number | null) => {
    const lit = raceLit(n, r.min_matches);
    const pips = [0, 1, 2].map((i) => `<i${i < lit ? ' class="on"' : ""}></i>`).join("");
    return `<div class="race-row"><i class="sw ${sw}"></i><span class="nm">${esc(name)}</span><span class="ms">${ms == null ? "—" : `${ms.toFixed(1)}<small>ms</small>`}</span><span class="pips" role="img" aria-label="${n} clean match${n === 1 ? "" : "es"} counted, ${r.min_matches} needed">${pips}</span></div>`;
  };
  const mixed = m.mixed ? ` ${m.mixed} match${m.mixed === 1 ? "" : "es"} switched path mid-match and ${m.mixed === 1 ? "doesn't" : "don't"} count.` : "";
  const foot = r.pick.vs ? `${esc(r.verdict.text)}${mixed}` : "No relay to race yet. Join one in the Relay section; each match on it lights its lane.";
  show(chips(r.pick.vs ? RACE_CHIP[r.verdict.kind] : "", r.verdict.kind === "gain") + row("now", "Direct", m.direct, m.direct_ms) + (r.pick.vs ? row("best", `Via ${r.pick.vs}`, m.relay, m.relay_ms) : "") + `<div class="foot">${foot}</div>` + (m.direct + m.relay ? `<div class="race-ctl">${replayBtn}</div>` : ""));
}

/** The replay's moving parts, without rebuilding the key: cursor, scrubber, time and ping, play button. */
function syncReplay(): void {
  const rp = state.race.replay;
  const el = $("raceKey");
  if (!rp) return;
  const i = state.race.at;
  const s = rp.samples[i];
  const scrub = el.querySelector<HTMLInputElement>('[data-r="scrub"]');
  if (scrub && Number(scrub.value) !== i) scrub.value = String(i);
  const now = el.querySelector('[data-r="now"]');
  const died = rp.deaths?.some((k) => k.at === i);
  if (now) now.textContent = s ? `${clockOf(s, i)} · ${s.ms.toFixed(1)} ms${s.lost ? ` · ${s.lost} lost` : ""}${died ? " · died" : ""}` : "";
  const x = rp.samples.length > 1 ? (i / (rp.samples.length - 1)) * 316 : 158;
  el.querySelector('[data-r="cursor"]')?.setAttribute("x1", String(x));
  el.querySelector('[data-r="cursor"]')?.setAttribute("x2", String(x));
  const play = el.querySelector<HTMLButtonElement>('[data-act="play"]');
  if (play) {
    play.textContent = state.race.playing ? "Pause" : "Play";
    play.setAttribute("aria-pressed", String(state.race.playing));
  }
}

/** The cursor moved: the key follows, and the lane sends that line's packet. The lanes themselves stay as drawn. */
function replayMoved(): void {
  syncReplay();
  globe.setPulse(racePulse());
}

/** Least time a replayed line stays on screen; a slower line waits for its packet to land, so a bad stretch plays slower. */
const REPLAY_STEP_MS = 450;
let replayTimer: ReturnType<typeof setTimeout> | undefined;

function playReplay(on: boolean): void {
  clearTimeout(replayTimer);
  const rp = state.race.replay;
  state.race.playing = on && !!rp;
  if (rp && state.race.playing) {
    if (state.race.at >= rp.samples.length - 1) state.race.at = 0;
    const next = () => {
      const s = rp.samples[state.race.at];
      replayTimer = setTimeout(
        () => {
          if (state.race.replay !== rp || !state.race.playing) return;
          if (state.race.at >= rp.samples.length - 1) return playReplay(false);
          state.race.at++;
          replayMoved();
          next();
        },
        Math.max(REPLAY_STEP_MS, (s?.ms ?? 0) * REPLAY_MS_PER_MS + 120),
      );
    };
    next();
  }
  replayMoved();
}

/** Open the replay on match `i` of the log (0 is the newest), reading the log first when needed. */
async function openReplay(i: number): Promise<void> {
  playReplay(false);
  if (!state.race.log.length || state.race.replayOf == null) {
    try {
      state.race.log = await api.call<MatchPing[]>("match_log");
    } catch {
      state.race.log = [];
    }
  }
  const m = state.race.log[i];
  Object.assign(state.race, { replayOf: i, replay: undefined, at: 0, error: m ? undefined : "No finished match in the log yet." });
  renderRaceKey();
  draw();
  if (!m) return;
  try {
    const rp = await api.call<MatchSeries>("match_series", { id: m.id });
    if (state.race.replayOf !== i) return;
    // Start at the worst minute, so the first frame shows what the replay is about.
    Object.assign(state.race, { replay: rp, at: rp.worst?.from ?? 0, error: rp.samples.length ? undefined : "The game wrote no connected lines for this match." });
  } catch (e) {
    state.race.error = String(e);
  }
  renderRaceKey();
  draw();
}

function closeReplay(): void {
  playReplay(false);
  Object.assign(state.race, { replayOf: null, replay: undefined, error: undefined });
  renderRaceKey();
  draw();
}

/** The key's buttons and scrubber. */
function wireRaceKey(): void {
  const el = $("raceKey");
  el.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const act = btn?.dataset.act;
    const i = state.race.replayOf;
    if (act === "death") {
      // The cursor goes to the line this death is pinned to, and playing stops.
      const at = state.race.replay?.deaths?.[Number(btn?.dataset.i)]?.at;
      if (at != null) {
        state.race.at = at;
        playReplay(false);
      }
    } else if (act === "replay") void openReplay(0);
    else if (act === "close") closeReplay();
    else if (act === "older" && i != null) void openReplay(i + 1);
    else if (act === "newer" && i != null) void openReplay(i - 1);
    else if (act === "play") playReplay(!state.race.playing);
  });
  el.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.r !== "scrub") return;
    // Moved by hand: the cursor goes there and playing stops.
    state.race.at = Number(t.value);
    playReplay(false);
  });
}

/**
 * Reads the match running now every few seconds. When a new match starts, the race view opens on
 * it once, unless Proof, the Peak log, the Passport or the gain map is open; closed mid-match, it stays closed.
 */
async function pollLive(): Promise<void> {
  let live: LiveMatch | null = null;
  try {
    live = await api.call<LiveMatch | null>("match_live");
  } catch {
    live = null;
  }
  const was = state.race.live;
  const now = Date.now();
  // The tunnel's byte rate between two reads of the same match. A counter that went back means the tunnel restarted.
  const dt = (now - state.race.liveAt) / 1000;
  const rate =
    live && was && was.id === live.id && dt > 0 && live.tunnel_rx != null && live.tunnel_tx != null && was.tunnel_rx != null && was.tunnel_tx != null && live.tunnel_rx >= was.tunnel_rx && live.tunnel_tx >= was.tunnel_tx
      ? { rx: (live.tunnel_rx - was.tunnel_rx) / dt, tx: (live.tunnel_tx - was.tunnel_tx) / dt }
      : undefined;
  const changed = !!was !== !!live || was?.id !== live?.id || was?.samples.length !== live?.samples.length || was?.path !== live?.path || rateText(rate?.rx ?? 0) !== rateText(state.race.rate?.rx ?? 0) || rateText(rate?.tx ?? 0) !== rateText(state.race.rate?.tx ?? 0);
  Object.assign(state.race, { live: live ?? undefined, liveAt: now, rate });
  if (live && !state.race.opened.has(live.id)) {
    state.race.opened.add(live.id);
    if (!state.race.open && !state.proof.open && !state.peak.open && !state.passport.open && !state.gainMap.open) return toggleRace(true);
  }
  if (!changed || !state.race.open) return;
  renderRaceKey();
  draw();
}

// ---------- passport ----------

/** A match's log id (its local start time) as a short date. */
const matchDay = (id: string): string => rangeFmt.format(new Date(id.slice(0, 10) + "T" + id.slice(11).replace(/-/g, ":")));

/** Networks named in the key before the rest are counted. */
const PASSPORT_NETS = 10;

/** A finished trace stamps what it crossed. */
async function stampPassport(hops: Hop[]): Promise<void> {
  const stamps = stampsOf(segsOf(hops));
  if (!stamps.cities.length && !stamps.networks.length) return;
  try {
    await api.call("passport_add", { stamps });
  } catch {
    return;
  }
  if (state.passport.open) void loadPassport();
}

async function loadPassport(): Promise<void> {
  try {
    state.passport.data = await api.call<Passport>("passport_read");
  } catch {
    return;
  }
  renderPassportKey();
  if (state.passport.open) draw();
}

/** Every stamped city as a box, each Riot Direct entry lit with its card. City cards carry the day it was first stamped. */
function drawPassport(addPoint: AddPoint): void {
  const p = state.passport.data;
  if (!p) return;
  const times = (n: number) => (n === 1 ? "once" : `${n} times`);
  for (const c of p.cities) addPoint(c.lat, c.lng, c.place, `<b>${esc(c.place)}</b><br><span class="m">First crossed ${rangeFmt.format(new Date(c.first))}, traced ${times(c.n)}</span>`, "hop", false, `${rangeFmt.format(new Date(c.first))} · ${c.place}`, 4);
  for (const r of p.riot) addPoint(r.lat, r.lng, r.place, `<b>${esc(r.place)}</b><br><span class="m">Entered Riot Direct here${r.from ? ` from ${esc(r.from)}` : ""}, traced ${times(r.n)}</span>`, "hop", true, `Riot Direct · ${r.place}`, 2);
}

/** The key in the legend's corner: what has been stamped, then personal bests. */
function renderPassportKey(): void {
  const el = $("passportKey");
  el.hidden = !state.passport.open;
  if (!state.passport.open) return;
  const p = state.passport.data;
  const head = (title: string, chip = "") => `<div class="label"><span>${title}</span>${chip ? `<span class="chip">${esc(chip)}</span>` : ""}</div>`;
  const show = (html: string) => {
    if (el.dataset.html !== html) el.innerHTML = el.dataset.html = html;
  };
  if (!p) return show(`${head("Passport")}<div class="foot">Reading your stamps.</div>`);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const since = p.cities.length ? Math.min(...p.cities.map((c) => c.first)) : null;
  const nets = [...p.networks].sort((a, b) => b.n - a.n || a.first - b.first);
  const named = nets.slice(0, PASSPORT_NETS).map((n) => n.name).join(", ") + (nets.length > PASSPORT_NETS ? `, ${nets.length - PASSPORT_NETS} more` : "");
  const stamped = p.cities.length || p.networks.length
    ? `<div class="foot">${plural(p.networks.length, "network")} · ${plural(p.riot.length, "Riot Direct entry", "Riot Direct entries")}${since != null ? ` · since ${rangeFmt.format(new Date(since))}` : ""}</div>` +
      (named ? `<div class="foot">${esc(named)}.</div>` : "") +
      (p.riot.length ? `<div class="foot">Entered Riot Direct at ${esc(p.riot.map((r) => `${r.place}${r.from ? ` from ${r.from}` : ""}`).join(", "))}.</div>` : "")
    : `<div class="foot">Nothing stamped yet. Each finished trace stamps the cities and networks it crossed.</div>`;
  const row = (name: string, value: string, day: string) => `<div class="pass-row"><span>${esc(name)}</span><span class="num">${esc(value)}</span><span class="when">${esc(day)}</span></div>`;
  const b = p.bests;
  const bests = b.by_path.length
    ? b.by_path.map((x) => row(pathText(x.path), `${x.ms.toFixed(1)} ms`, matchDay(x.id))).join("") +
      (b.steadiest ? row("Steadiest match", `${b.steadiest.ms.toFixed(1)} ms jitter`, matchDay(b.steadiest.id)) : "") +
      (b.clean_run ? `<div class="foot">Longest run with no packet lost: ${plural(b.clean_run, "match", "matches")}.</div>` : "")
    : `<div class="foot">No full match read yet, so no personal bests.</div>`;
  show(head("Passport", plural(p.cities.length, "city", "cities")) + stamped + head("Personal bests") + bests);
}

/** Frame this PC and everywhere stamped. */
function fitPassport(): void {
  const p = state.passport.data;
  const pts = [...(state.home ? [state.home] : []), ...(p?.cities ?? []), ...(p?.riot ?? [])];
  if (pts.length) globe.fitPoints(pts);
}

function togglePassport(open = !state.passport.open): void {
  if (open && state.gainMap.open) toggleGainMap(false);
  if (open && state.proof.open) toggleProof(false);
  if (open && state.peak.open) togglePeak(false);
  if (open && state.race.open) toggleRace(false);
  state.passport.open = open;
  $("viewPassport").setAttribute("aria-pressed", String(open));
  $("stage").classList.toggle("passport-open", open);
  renderPassportKey();
  draw();
  if (open) void loadPassport().then(() => state.passport.open && fitPassport());
}

// ---------- ISP gain map ----------

/** Country centres from the land file, read once when the map first opens. */
let countries: Promise<Map<string, [number, number]>> | undefined;
const loadCountries = (): Promise<Map<string, [number, number]>> =>
  (countries ??= fetch("/countries.geojson")
    .then((r) => r.json())
    .then(countryCentres)
    .catch(() => new Map()));
let placeTable = new Map<string, [number, number]>();

let gainMapLoading: Promise<void> = Promise.resolve();
function loadGainMap(refresh: boolean): Promise<void> {
  return (gainMapLoading = gainMapLoading.then(async () => {
    placeTable = await loadCountries();
    try {
      state.gainMap.data = await api.call<GainMap | null>("relay_gain_map", { refresh });
      state.gainMap.error = undefined;
    } catch (e) {
      state.gainMap.error = e instanceof Error ? e.message : String(e);
    }
    renderGainKey();
    if (state.gainMap.open) draw();
  }));
}

/** One line of a box's tooltip or the key: the network, what it measured, from how many players. */
function gainLine(c: GainCell, minPlayers: number): string {
  const r = c.row;
  const from = c.source === "estimate" ? "gain checks" : "in game";
  const medians = r ? ` · ${r.median_direct_ms.toFixed(0)} ms direct, ${r.median_relay_ms.toFixed(0)} ms relay` : "";
  return `${esc(netName(c))} ${esc(cellValue(c, minPlayers))}${r ? ` ${from}` : " so far"} · ${c.players === 1 ? "1 player" : `${c.players} players`}${r && c.source === "in_game" ? `, ${r.gaining} by ${state.gainMap.data!.bar_ms} ms or more` : ""}${medians}`;
}

/** One box per region the relay's players reported from. Regions where a network gains the bar in game are lit. */
function drawGainMap(addPoint: AddPoint): void {
  const m = state.gainMap.data;
  if (!m) return;
  for (const g of layout(m, placeTable).placed) {
    const where = g.place.level === "country" ? "Placed at the country's centre" : "Placed at the region's centre";
    const detail = `<b>${esc(g.region)}</b><br><span class="m">${g.cells.map((c) => gainLine(c, m.min_players)).join("<br>")}<br>${where}, not at a player</span>`;
    addPoint(g.place.lat, g.place.lng, g.region, detail, "hop", lit(g), cardText(g, m.min_players), lit(g) ? 2 : 3);
  }
}

/** The key: what the map shows, every network and region, and what is not placed. */
function renderGainKey(): void {
  const el = $("gainKey");
  el.hidden = !state.gainMap.open;
  if (!state.gainMap.open) return;
  const head = (title: string, chip = "") => `<div class="label"><span>${title}</span>${chip ? `<span class="chip">${esc(chip)}</span>` : ""}</div>`;
  const show = (html: string) => {
    if (el.dataset.html !== html) el.innerHTML = el.dataset.html = html;
  };
  const m = state.gainMap.data;
  if (state.gainMap.error && !m) return show(`${head("ISP gain map")}<div class="foot">Could not read the relay's gain table: ${esc(state.gainMap.error)}</div>`);
  if (m === undefined) return show(`${head("ISP gain map")}<div class="foot">Reading the relay's gain table.</div>`);
  if (m === null) return show(`${head("ISP gain map")}<div class="foot">No data yet: join a relay with an invite to see which ISP networks it helps.</div>`);
  const { placed, unplaced } = layout(m, placeTable);
  const row = (c: GainCell, where: string) => `<div class="pass-row gain-row" data-kind="${c.kind}"><span>${esc(where)} · ${esc(netName(c))}</span><span class="num">${esc(c.gain_ms == null ? `needs ${m.min_players - c.players} more` : cellValue(c, m.min_players))}</span><span class="when">${c.players === 1 ? "1 player" : `${c.players} players`}</span></div>`;
  const rows = [...placed.flatMap((g) => g.cells.map((c) => row(c, g.place.name))), ...unplaced.map((c) => row(c, c.region ?? "Whole network"))];
  const read = `Read ${rangeFmt.format(new Date(m.fetched_ms))} ${timeFmt.format(new Date(m.fetched_ms))}`;
  const rule = `A number shows once ${m.min_players} players reported it. Lit boxes gain ${m.bar_ms} ms or more in game.`;
  if (!rows.length)
    return show(`${head("ISP gain map", m.relay)}<div class="foot">No data yet: no player has reported to ${esc(m.relay)}. The app sends your numbers after ${m.min_players} League matches on each path, and the gain check script sends an estimate.</div><div class="foot">${esc(read)}.</div>`);
  const notPlaced = unplaced.length ? `<div class="foot">${unplaced.length === 1 ? "1 row has" : `${unplaced.length} rows have`} no region on the map and ${unplaced.length === 1 ? "is" : "are"} listed only.</div>` : "";
  show(`${head("ISP gain map", m.relay)}<div class="foot">Players who measured ${esc(m.relay)}, by ISP network and region. ${rule}</div>${rows.join("")}${notPlaced}<div class="foot">${esc(read)}. Est. = gain check, not yet measured in game.</div>`);
}

/** Frame this PC and every placed region. */
function fitGainMap(): void {
  const m = state.gainMap.data;
  const pts = [...(state.home ? [state.home] : []), ...(m ? layout(m, placeTable).placed.map((g) => g.place) : [])];
  if (pts.length) globe.fitPoints(pts);
}

function toggleGainMap(open = !state.gainMap.open): void {
  if (open && state.proof.open) toggleProof(false);
  if (open && state.peak.open) togglePeak(false);
  if (open && state.race.open) toggleRace(false);
  if (open && state.passport.open) togglePassport(false);
  state.gainMap.open = open;
  $("viewGainMap").setAttribute("aria-pressed", String(open));
  $("stage").classList.toggle("gainmap-open", open);
  renderGainKey();
  draw();
  if (open) void loadGainMap(false).then(() => state.gainMap.open && fitGainMap());
}

/** Frame this PC, the relay and the game servers. */
function fitRace(): void {
  if (!state.home) return;
  const end = LANDMARKS[0];
  const vs = state.race.live && laneOf(state.race.live.path) === "relay" ? state.race.live.path : state.race.data?.pick.vs;
  const saved = vs ? allRelays().find((x) => x.name === vs) : undefined;
  const at = saved ? state.relayMeasures.get(saved.host) : undefined;
  globe.fitPoints([state.home, { lat: end.lat, lng: end.lng }, ...(at?.lat != null && at.lng != null ? [{ lat: at.lat, lng: at.lng }] : [])]);
}

function toggleRace(open = !state.race.open): void {
  if (open && state.proof.open) toggleProof(false);
  if (open && state.peak.open) togglePeak(false);
  if (open && state.passport.open) togglePassport(false);
  if (open && state.gainMap.open) toggleGainMap(false);
  if (!open) {
    playReplay(false);
    Object.assign(state.race, { replayOf: null, replay: undefined, error: undefined });
  }
  state.race.open = open;
  $("viewRace").setAttribute("aria-pressed", String(open));
  $("stage").classList.toggle("race-open", open);
  renderRaceKey();
  draw();
  if (open) {
    fitRace();
    void loadRace();
  }
}

// ---------- wiring ----------

function wireUi(): void {
  $<HTMLInputElement>("filter").addEventListener("input", (e) => {
    state.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
    renderProcs();
    rebuildDests();
  });
  $("procs").addEventListener("click", async (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-key]");
    if (!li) return;
    const name = li.dataset.key!;
    if ((e.target as HTMLElement).closest(".pin")) {
      state.config.focus = state.config.focus === name ? null : name;
      await saveConfig();
    } else {
      state.selectedProc = state.selectedProc === name ? null : name;
    }
    renderProcs();
    rebuildDests();
  });
  $("dests").addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-key]");
    if (li) selectDest(li.dataset.key!);
  });
  // Rows are focusable: Enter or Space acts like a click, on processes and destinations alike.
  for (const id of ["procs", "dests"]) {
    $(id).setAttribute("role", "listbox");
    $(id).addEventListener("keydown", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-key]");
      if (!li || e.target !== li || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      li.click();
    });
  }
  $("traceAll").addEventListener("click", () => {
    for (const d of state.dests.values()) queueTrace(d.ip, true);
    renderDests();
  });
  // Hovering a process lights up where its connections go, without selecting it.
  const procsEl = $("procs");
  const hoverTo = (name: string | null) => {
    if (name === state.hoverProc) return;
    state.hoverProc = name;
    draw();
  };
  procsEl.addEventListener("mouseover", (e) => hoverTo((e.target as HTMLElement).closest<HTMLElement>("li[data-key]")?.dataset.key ?? null));
  procsEl.addEventListener("mouseleave", () => hoverTo(null));
  $("viewHome").addEventListener("click", () => state.home && globe.flyTo(state.home.lat, state.home.lng, 1.3, 900, 16));
  $("viewFit").addEventListener("click", () => (state.gainMap.open ? fitGainMap() : state.passport.open ? fitPassport() : state.race.open ? fitRace() : globe.fitPoints(routePoints(selectedTrace()))));
  $("viewSpin").addEventListener("click", (e) => (e.currentTarget as HTMLButtonElement).setAttribute("aria-pressed", String(globe.toggleSpin())));
  $("viewRace").addEventListener("click", () => toggleRace());
  $("viewPassport").addEventListener("click", () => togglePassport());
  $("viewGainMap").addEventListener("click", () => toggleGainMap());
  wireRaceKey();
  // A match read, started or ended while the app sat in the background shows as soon as it is back.
  window.addEventListener("focus", () => {
    void loadRace();
    void pollLive();
    if (state.gainMap.open) void loadGainMap(true);
  });

  const form = $<HTMLFormElement>("relayForm");
  $("addRelay").addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) $<HTMLInputElement>("relayName").focus();
  });
  $("relayCancel").addEventListener("click", () => (form.hidden = true));
  $("relayHost").addEventListener("input", (e) => (e.target as HTMLInputElement).setCustomValidity(""));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const hostInput = $<HTMLInputElement>("relayHost");
    const r: Relay = { name: $<HTMLInputElement>("relayName").value.trim(), host: hostInput.value.trim() };
    if (!r.name || !r.host) return;
    // Measurements are keyed by host, so a second relay on the same host would overwrite the first.
    const dup = state.config.relays.find((x) => x.host.toLowerCase() === r.host.toLowerCase());
    if (dup) {
      hostInput.setCustomValidity(`Already added as ${dup.name}`);
      hostInput.reportValidity();
      return;
    }
    state.config.relays.push(r);
    await saveConfig();
    form.reset();
    form.hidden = true;
    rankRelays();
    void measureRelays();
  });
}

async function boot(): Promise<void> {
  api = await createBackend();
  wireEvents();
  wireUi();
  wirePeak();
  wireProof();
  relayUi = mountRelay(api, document.getElementById("relay")!, {
    game: {
      current: () => state.config.game || DEFAULT_GAME,
      running: () => [...state.procs.keys()],
      set: (process) => {
        state.config.game = process;
        void saveConfig();
      },
    },
    gameTarget: () => {
      const game = state.config.game || DEFAULT_GAME;
      const flows = state.conns.filter((c) => c.proto === "udp" && isGameProcess(c.process, game) && /^[0-9a-f.:]+$/i.test(c.remote_ip) && c.remote_ip !== "0.0.0.0" && !isPrivateIp(c.remote_ip));
      // League's match is its UDP flow to Riot's game port range. Another game's is its own UDP flow,
      // on the game port range when it uses one.
      const live = flows.find((c) => service(c.remote_port) === "game") ?? (/^league of legend/i.test(game) ? undefined : flows[0]);
      return live?.remote_ip ?? null;
    },
    // Every Auto run is a measured direct-vs-relay result, so it counts toward the refund rule.
    onAuto: (r) => {
      if (r.record) void readProofLog().then(renderProof);
    },
    // The map and the Relays list mark the relay the tunnel is on.
    onStatus: (s) => {
      const was = state.tunnel;
      state.tunnel = s;
      // Billing is the tunnel's relay's: picking another relay reads that one's.
      if (was && was.name !== s.name) void billingUi?.refresh();
      if (was?.name === s.name && was?.state === s.state) return;
      // Another relay has its own gain table.
      if (was && was.name !== s.name) {
        void loadRelayGain(false);
        if (state.gainMap.open) void loadGainMap(false);
      }
      renderPathChip();
      renderRank(rankedRelays);
      draw();
    },
    // A relay imported in the Relay section joins the Relays list right away.
    onRelaysChanged: () => {
      void loadRelayGain(false);
      if (state.gainMap.open) void loadGainMap(false);
      void loadRace();
      void loadTunnelRelays().then(() => {
        rankRelays();
        void measureRelays();
      });
      // A joined relay can bill this device (a signup starts a trial): show its plan now.
      void billingUi?.refresh();
    },
  });
  // The webview blocks target=_blank, so external links go to the system browser.
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.<HTMLAnchorElement>("a[data-external]");
    if (!a || api.mock) return;
    e.preventDefault();
    void api.call("plugin:opener|open_url", { url: a.href }).catch(() => {});
  });
  renderPathChip();
  const monthCard = mountRelayMonth();
  mountRelayGain();
  // On a billed relay this month's verdict reads under Billing, beside what it decides. Without
  // billing there is no refund to decide, so the card stays out of the Relay section.
  billingUi = mountBilling(api, document.getElementById("billing")!, { monthCard });
  setStatus("loading land");
  await globe.loadLand("/countries.geojson").catch(() => setStatus("land data missing"));
  await loadConfig();
  relayUi.fillGames();
  await loadTunnelRelays();
  setStatus("locating this machine");
  try {
    const [g] = await api.call<Geo[]>("geolocate", { ips: ["self"] });
    if (g?.lat != null && g.lon != null) {
      state.home = { lat: g.lat, lng: g.lon, label: [g.city, g.regionName].filter(Boolean).join(", ") || "Home" };
      globe.flyTo(state.home.lat, state.home.lng, 1.3, 0, 16);
    }
  } catch (e) {
    setStatus(`home location unavailable: ${String(e)}`);
  }
  renderRoute();
  rankRelays();
  draw();
  await refreshConnections();
  if (state.config.focus && state.procs.has(state.config.focus)) {
    state.selectedProc = state.config.focus;
    renderProcs();
    rebuildDests();
    const first = [...state.dests.values()][0];
    if (first) selectDest(first.key);
  }
  void measureRelays();
  setInterval(() => void refreshConnections(), 4000);
  setInterval(() => void measureRelays(), 60000);
  void ingestMatches();
  setInterval(() => void ingestMatches(), 60000);
  void loadRace();
  // The game writes a netstats line every 10 s: reading twice as often shows each one soon after.
  void pollLive();
  setInterval(() => void pollLive(), 5000);
  setStatus(idleStatus());
}

mountDock();
void boot();
