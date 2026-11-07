import { createBackend, type Backend } from "./backend";
import { mountRelay } from "./relay";
import { RouteGlobe, type ArcDatum, type LabelWant, type NodeKind, type PointDatum } from "./globe";
import { estimateLegMs, fitsNeighbours, haversineKm, isPrivateIp, placeFromRdns, plausibleForRtt, REALISTIC, type Anchor } from "./geo";
import { biggestJump, floorRtts, town, netChain, networkOf, pathKey, samePath, segments, viaCities, type Segment } from "./route";
import { DEFAULT_PEAK, planSchedule, RELAY_WORTH_MS, summarize, verdict, type PeakPath, type PeakPoint, type PeakSummary } from "./peak";
import { proofVerdict, RELAY_NET, routeStats, type RouteStats } from "./proof";
import type { CompareProgress, Conn, Config, Dest, DoneEvent, Geo, Hop, HopEvent, PeakConfig, PeakSample, PeakStatus, PingStats, RdnsEvent, Relay, RelayComparison, RelayMeasure, RouteVariant, Trace } from "./types";

// ---------- state ----------

const state = {
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
  return `${state.conns.length} connections · live${api?.mock ? " · replay data" : ""}`;
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
  t.note = `Re-trace ${why}. Showing the earlier route.`;
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

/** What the destination is, in words: who runs it, where, and what for. */
function destinationLine(t: Trace): string {
  const d = state.selectedDest ? state.dests.get(state.selectedDest) : undefined;
  const g = state.geo.get(t.target);
  const destHop = [...t.hops.values()].find((h) => h.ip === t.target);
  const owner = networkOf({ hop: 0, ip: t.target, rtts: [], avg: null, rdns: destHop?.rdns }, g)?.name;
  const end = routeEnd(t);
  const svc = d ? service(d.port) : undefined;
  const role = svc === "game" ? "game server" : svc === "stun" || svc === "wireguard" || svc === "vpn" ? "relay" : svc ? `${svc} server` : "server";
  const who = d ? [...d.processes].map(esc).join(", ") : "This machine";
  const where = end && end.replied ? ` in <b>${esc(end.place)}</b>` : g?.city ? ` in <b>${esc(geoPlace(g, t.target))}</b>` : "";
  const silent = t.done && !end?.replied ? ` · does not answer traces${g?.city ? ", placed by GeoIP" : ""}` : "";
  return `<b>${who}</b> → ${owner ? `<b>${esc(owner)}</b> ` : ""}${role}${where}${d ? ` · ${d.proto} ${d.port}` : ""}${silent}`;
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

async function saveConfig(): Promise<void> {
  await api.call("write_config", { config: state.config });
}

async function measureRelays(): Promise<void> {
  for (const r of state.config.relays) {
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
  for (const r of state.config.relays) {
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
  const pts = routePoints(selectedTrace());
  if (pts.length > 1) globe.fitPoints(pts);
}

function renderRoute(): void {
  const t = selectedTrace();
  const ol = $("hops");
  ol.innerHTML = "";
  if (!t) {
    $("routeTarget").textContent = "";
    $("routeTotal").textContent = "—";
    $("routeStats").innerHTML = "";
    $("hopCount").textContent = "";
    $("routeMeta").textContent = "Pick a destination to trace it.";
    $("routeDest").innerHTML = "";
    ol.innerHTML = `<li class="empty">Hops appear here as the trace runs.</li>`;
    renderJourney(undefined, []);
    renderRoutes(undefined);
    return;
  }
  const hops = [...t.hops.values()].sort((a, b) => a.hop - b.hop);
  const last = hops.filter((h) => h.avg != null).pop();
  $("routeTarget").textContent = t.target;
  $("routeTotal").innerHTML = last?.avg != null ? `${last.avg.toFixed(0)}<small>ms</small>` : t.done ? `<small>no reply</small>` : "…";
  $("routeDest").innerHTML = destinationLine(t);
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
  const jumpText = jump
    ? (() => {
        const a = segOf.get(jump.from);
        const b = segOf.get(jump.to);
        const at = (h: Hop) => (h.lat != null && h.source !== "home" ? town(h.place ?? "") : h.source === "home" ? "your network" : `hop ${h.hop}`);
        const nets = a && b && a !== b ? ` (${esc(a.net.name)} → ${esc(b.net.name)})` : b ? ` (inside ${esc(b.net.name)})` : "";
        return `<br>Most time added: <b>+${jump.ms.toFixed(0)} ms</b> from ${esc(at(jump.from))} to ${esc(at(jump.to))}${nets}`;
      })()
    : "";
  $("routeStats").innerHTML = `<div><b>${hops.length}</b><span>hops</span></div><div><b>${pathKm ? pathKm.toFixed(0) : "—"}</b><span>km path</span></div><div><b>${direct ? direct.toFixed(0) : "—"}</b><span>km direct</span></div>`;
  $("routeMeta").innerHTML =
    (end ? `Ends near <b>${esc(end.place ?? "")}</b>` : t.done ? "No located hop replied" : "Tracing") +
    (detours ? `<span class="chip">${detours} backwards</span>` : "") +
    jumpText +
    (t.error ? `<br>${esc(t.error)}` : "") +
    (t.note ? `<br>${esc(t.note)}` : "");
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
    if (located) li.addEventListener("click", () => globe.flyTo(h.lat!, h.lng!, 0.6));
    ol.appendChild(li);
  }
}

/** One row per network the packets cross, with the time each one adds. */
function renderJourney(t: Trace | undefined, segs: Segment[]): void {
  const ol = $("journey");
  $("journeyChain").textContent = segs.length ? `${segs.filter((x) => x.net.id !== "home").length} networks` : "";
  if (!t || !segs.length) {
    ol.innerHTML = `<li class="empty">${t ? (t.done ? "No hop answered." : "Waiting for hops.") : "Who carries your traffic, and where the time goes."}</li>`;
    return;
  }
  const worst = segs.reduce<Segment | undefined>((w, x) => ((x.addedMs ?? 0) > (w?.addedMs ?? 0) ? x : w), undefined);
  const total = Math.max(1, ...segs.map((x) => x.exitMs ?? 0));
  const rows = segs.map((sg) => {
    const places = sg.from && sg.to && town(sg.from) !== town(sg.to) ? `${esc(town(sg.from))} → ${esc(town(sg.to))}` : sg.from ? esc(town(sg.from)) : "location unknown";
    const hopsTxt = sg.first === sg.last ? `hop ${sg.first}` : `hops ${sg.first}–${sg.last}`;
    const km = sg.km && sg.km >= 50 ? ` · ${sg.km.toFixed(0)} km` : "";
    const add = sg.addedMs != null ? `+${sg.addedMs.toFixed(0)}` : "·";
    const w = sg.addedMs != null ? Math.max(2, Math.round((sg.addedMs / total) * 100)) : 0;
    const cls = [sg === worst && (worst.addedMs ?? 0) >= 5 ? "worst" : "", sg.slow ? "slow" : ""].join(" ").trim();
    return `<li class="${cls}"><span class="add">${add}<small>ms</small></span><div><div class="where">${esc(sg.net.name)}${sg.net.asn ? `<span class="asn">${esc(sg.net.asn)}</span>` : ""}${sg.slow ? `<span class="flag">slow for distance</span>` : ""}</div><div class="who">${places} · ${hopsTxt}${km}</div><span class="bar"><i style="width:${w}%"></i></span></div></li>`;
  });
  const end = routeEnd(t);
  if (t.done && end && !end.replied) rows.push(`<li class="end"><span class="add">?</span><div><div class="where">Destination did not answer</div><div class="who">The last answering hop is the closest measured point</div></div></li>`);
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
  const rows: { name: string; ms: string; detail: string; selected: boolean; onClick?: () => void }[] = [];
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
    row.className = "r";
    row.setAttribute("aria-selected", String(r.selected));
    row.innerHTML = `<span class="nm">${esc(r.name)}</span><span class="tot">${r.ms}</span><span></span><span class="br">${r.detail}</span>`;
    if (r.onClick) row.addEventListener("click", r.onClick);
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
        : `${m.rtt.toFixed(0)} ms to relay` + (m.legEst != null ? ` + ~${m.legEst.toFixed(0)} ms onward` : m.geoNote ? ` · ${esc(m.geoNote)}` : t ? " · destination not located" : " · pick a destination") + (delta != null ? ` <span class="delta">${delta <= 0 ? "" : "+"}${delta.toFixed(0)} ms vs now</span>` : m.legEst != null && t?.done && !end?.replied ? ` · destination silent, no comparison` : "");
    row.innerHTML = `<span class="nm">${esc(m.relay.name)}</span><span class="tot">${right}</span><button class="x" type="button" title="Remove relay">×</button><span class="br">${detail}</span>`;
    row.addEventListener("click", () => {
      state.selectedRelay = m.relay.host;
      renderRank(ranked);
      renderRoutes(selectedTrace());
      draw();
    });
    row.querySelector<HTMLButtonElement>(".x")!.addEventListener("click", async (e) => {
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
  const addPoint = (lat: number, lng: number, label: string, detail: string, kind: NodeKind, bright: boolean, text?: string, prio = 3) => {
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
    if (text) wants.push({ p, text, prio });
  };

  if (state.home) addPoint(state.home.lat, state.home.lng, state.home.label, "This machine", "home", true, state.home.label, 0);

  /** Draw a hop path from home. `style` picks the look; labels only for the selected route. */
  const drawPath = (name: string, hopsIn: Hop[], style: "sel" | "dim" | "alt" | "relay", labels: boolean): Hop | undefined => {
    const hops = [...hopsIn].sort((a, b) => a.hop - b.hop).filter((h) => h.lat != null && h.lng != null);
    const end = hops.filter((h) => h.source !== "home").pop();
    const segOf = new Map<Hop, Segment>();
    if (style !== "dim") for (const sg of segsOf(hopsIn)) for (const h of sg.hops) segOf.set(h, sg);
    const floors = style !== "dim" ? floorRtts([...hopsIn].sort((a, b) => a.hop - b.hop)) : new Map<number, number>();
    const look = { sel: ["#d0d0d0", 0.08, true], dim: ["#303030", 0.04, false], alt: ["#8a8a8a", 0.11, false], relay: ["#ffffff", 0.14, false] } as const;
    const [color, alt, dash] = look[style];
    // Every route leaves from this machine, even when the gateway does not answer.
    let prev: Hop | undefined = state.home ? { hop: 0, ip: null, rtts: [], avg: null, lat: state.home.lat, lng: state.home.lng, place: state.home.label, source: "home" } : undefined;
    let prevSeg: Segment | undefined;
    for (const h of hops) {
      const sg = segOf.get(h);
      const f = floors.get(h.hop);
      const pf = prev ? floors.get(prev.hop) ?? 0 : 0;
      if (prev && (prev.lat !== h.lat || prev.lng !== h.lng)) {
        const add = f != null ? ` · +${Math.max(0, f - pf).toFixed(0)} ms` : h.avg != null ? ` · ${h.avg.toFixed(0)} ms` : "";
        arcs.push({ sLat: prev.lat!, sLng: prev.lng!, eLat: h.lat!, eLng: h.lng!, color, stroke: 0, alt, dash, label: `<b>${esc(name)}</b> hop ${h.hop}${sg ? ` · ${esc(sg.net.name)}` : ""}<br><span class="m">${esc(prev.place ?? "")} → ${esc(h.place ?? "")}${add}</span>` });
      }
      if (h.source !== "home") {
        // Where the route enters a new network, its label names the network.
        const entering = sg && sg !== prevSeg && sg.net.id !== "home";
        const text = labels ? (entering ? `${sg.net.name} · ${h.place}` : h.place) : undefined;
        addPoint(h.lat!, h.lng!, h.place ?? h.ip ?? "", `${esc(name)} hop ${h.hop}${sg ? ` · ${esc(sg.net.name)}` : ""}${h.avg != null ? ` · ${h.avg.toFixed(0)} ms` : ""}${h.rdns ? `<br>${esc(h.rdns)}` : ""}${h.estimated ? `<br>Location estimated: ${esc(h.estimated)}` : ""}`, "hop", style !== "dim", text, h === end ? 2 : entering ? 2.5 : 3);
      }
      if (sg) prevSeg = sg;
      prev = h;
    }
    return end;
  };

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
    globe.setData(arcs, [...points.values()], wants);
    return;
  }
  // With the peak log open, the path picked there is the one drawn and labelled; live traces stay dim.
  const peakPath = selectedPeakPath();
  if (peakPath) {
    for (const t of state.traces.values()) drawPath(t.target, [...t.hops.values()], "dim", false);
    drawPath(`Peak ${pathName(state.peak.selected!)}`, peakPath.hops, "sel", true);
    globe.setData(arcs, [...points.values()], wants);
    return;
  }
  for (const t of state.traces.values()) drawPath(t.target, [...t.hops.values()], t.target === sel ? "sel" : "dim", t.target === sel);

  // An earlier path to the selected destination, picked in the Routes list.
  const selT = selectedTrace();
  const v = selT && state.selectedVariant != null ? selT.variants?.[state.selectedVariant] : undefined;
  if (v) drawPath(`${selT!.target} ${variantName(state.selectedVariant!)}`, v.hops, "alt", true);

  // Best relay route: home → measured path to the relay → destination. The onward leg fades to mark the estimate.
  const end = routeEnd(selectedTrace());
  const relay = state.selectedRelay ? state.relayMeasures.get(state.selectedRelay) : undefined;
  if (state.home && end && relay && relay.lat != null && relay.lng != null && relay.total != null) {
    const rt = state.relayTraces.get(RELAY + relay.relay.host);
    const last = rt ? drawPath(`via ${relay.relay.name}`, [...rt.hops.values()].filter((h) => h.source !== "home"), "relay", false) : undefined;
    const from = last && haversineKm(last.lat!, last.lng!, relay.lat, relay.lng) > 30 ? last : state.home;
    if (!last || from === last) arcs.push({ sLat: from.lat!, sLng: from.lng!, eLat: relay.lat, eLng: relay.lng, color: "#ffffff", stroke: 0, alt: 0.14, dash: false, label: `<b>via ${esc(relay.relay.name)}</b><br><span class="m">${relay.rtt!.toFixed(0)} ms measured to relay</span>` });
    arcs.push({ sLat: relay.lat, sLng: relay.lng, eLat: end.lat, eLng: end.lng, color: ["#ffffff", "rgba(255,255,255,0.3)"], stroke: 0, alt: 0.14, dash: false, label: `<b>${esc(relay.relay.name)} → ${esc(end.place)}</b><br><span class="m">~${relay.legEst!.toFixed(0)} ms estimated from distance</span>` });
    addPoint(relay.lat, relay.lng, relay.relay.name, `relay · ${relay.rtt!.toFixed(0)} ms from here`, "relay", true, relay.relay.name, 1);
  }

  globe.setData(arcs, [...points.values()], wants);
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
  $("peakRange").textContent = sum?.from != null ? `${dayFmt.format(sum.from)} – ${dayFmt.format(sum.to!)}` : "";
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
    row.addEventListener("click", () => {
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
  all.forEach((a, i) => {
    const d = dayKey(a.pt.ts);
    if (d === prevDay) return;
    prevDay = d;
    const x = i ? (xOf(i - 1) + xOf(i)) / 2 : L;
    if (i) {
      parts.push(`<line class="dayline" x1="${x}" x2="${x}" y1="${T}" y2="${H - B}"/>`);
      hparts.push(`<line class="dayline" x1="${x}" x2="${x}" y1="0" y2="${HH}"/>`);
    }
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
  if (open && state.proof.open) toggleProof(false);
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
    const cfg = state.config.relays.find((x) => x.host === r.relay_host);
    const g = state.geo.get(r.relay_host);
    const lat = cfg?.lat ?? g?.lat ?? undefined;
    const lng = cfg?.lng ?? g?.lon ?? undefined;
    state.proof.at = lat != null && lng != null ? { lat, lng, name: cfg?.name ?? `Relay · ${g ? geoPlace(g, r.relay_host) : r.relay_host}` } : undefined;
    state.proof.result = r;
    state.proof.direct = proofHops(r.direct);
    state.proof.relay = proofHops(r.relay, state.proof.at);
  } catch (e) {
    state.proof.error = String(e);
  }
  state.proof.running = false;
  state.proof.progress = undefined;
  renderProof();
  draw();
  fitProof();
}

function fitProof(): void {
  const pts = [...routePoints({ hops: new Map(state.proof.direct.map((h) => [h.hop, h])) }), ...state.proof.relay.filter((h) => h.lat != null).map((h) => ({ lat: h.lat!, lng: h.lng! }))];
  if (state.proof.at) pts.push(state.proof.at);
  globe.fitPoints(pts);
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
      : "Starting. Windows may ask twice to switch the relay tunnel."
    : p.error
      ? `Comparison failed: ${p.error}`
      : "Both routes are measured to the same server, one after the other. Nothing is estimated.";
  const r = p.result;
  const verdictEl = $("proofVerdict");
  const body = $("proofBody");
  if (!r) {
    verdictEl.className = "peak-verdict unknown";
    verdictEl.innerHTML = p.running ? "Measuring both routes. The verdict appears when both are done." : "No comparison yet. Run one to see what the relay changes, measured, before you pay for it.";
    body.hidden = true;
    $("proofWhen").textContent = "";
    return;
  }
  body.hidden = false;
  const v = proofVerdict(r);
  verdictEl.className = `peak-verdict ${v.kind}`;
  verdictEl.innerHTML = `<span class="chip">${{ gain: "Gain", none: "No gain", worse: "Slower", unknown: "No verdict" }[v.kind]}</span>${esc(v.text)}`;
  $("proofWhen").textContent = `${r.target}${p.at ? ` · ${p.at.name}` : ""} · ${whenFmt.format(new Date(r.finished_at))}`;
  const d = routeStats(r.direct);
  const rs = r.relay ? routeStats(r.relay) : undefined;
  // Lower is better for every row. Change is relay minus direct.
  const rows: [string, (s: RouteStats) => number | undefined, (v: number) => string, boolean?][] = [
    ["Median", (s) => s.median, (x) => fmtMs(x), true],
    ["p90", (s) => s.p90, (x) => fmtMs(x)],
    ["Best", (s) => s.min, (x) => fmtMs(x)],
    ["Jitter", (s) => s.jitter, (x) => fmtMs(x)],
    ["Loss", (s) => s.loss, fmtPct],
    ["Hops", (s) => s.hops, (x) => String(x)],
  ];
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
  renderProofStrip(r);
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
  if (open && state.peak.open) togglePeak(false);
  state.proof.open = open;
  $("proof").hidden = !open;
  $("stage").classList.toggle("proof-open", open);
  $("viewProof").setAttribute("aria-pressed", String(open));
  if (open) {
    const input = $<HTMLInputElement>("proofTarget");
    if (!state.proof.running) input.value = state.proof.result?.target ?? proofTarget();
    renderProof();
    if (state.proof.result) fitProof();
  }
  draw();
}

function wireProof(): void {
  $("viewProof").addEventListener("click", () => toggleProof());
  $<HTMLFormElement>("proofForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void runProof();
  });
  api.on<CompareProgress>("compare:progress", (ev) => {
    if (!state.proof.running) return;
    state.proof.progress = ev;
    renderProof();
  });
  new ResizeObserver(() => state.proof.open && state.proof.result && renderProofStrip(state.proof.result)).observe($("proofStrip") as unknown as Element);
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
  $("viewHome").addEventListener("click", () => state.home && globe.flyTo(state.home.lat, state.home.lng, 1.3));
  $("viewFit").addEventListener("click", () => globe.fitPoints(routePoints(selectedTrace())));
  $("viewSpin").addEventListener("click", (e) => (e.currentTarget as HTMLButtonElement).setAttribute("aria-pressed", String(globe.toggleSpin())));

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
  mountRelay(api, document.getElementById("relay")!);
  setStatus("loading land");
  await globe.loadLand("/countries.geojson").catch(() => setStatus("land data missing"));
  await loadConfig();
  setStatus("locating this machine");
  try {
    const [g] = await api.call<Geo[]>("geolocate", { ips: ["self"] });
    if (g?.lat != null && g.lon != null) {
      state.home = { lat: g.lat, lng: g.lon, label: [g.city, g.regionName].filter(Boolean).join(", ") || "Home" };
      globe.flyTo(state.home.lat, state.home.lng, 1.3, 0);
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
  setStatus(idleStatus());
}

void boot();
