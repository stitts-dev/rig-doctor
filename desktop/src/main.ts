import { createBackend, type Backend } from "./backend";
import { RouteGlobe, type ArcDatum, type LabelWant, type NodeKind, type PointDatum } from "./globe";
import { estimateLegMs, haversineKm, isPrivateIp, placeFromRdns, plausibleForRtt, REALISTIC } from "./geo";
import type { Conn, Config, Dest, DoneEvent, Geo, Hop, HopEvent, PingStats, RdnsEvent, Relay, RelayMeasure, Trace } from "./types";

// ---------- state ----------

const state = {
  conns: [] as Conn[],
  procs: new Map<string, Conn[]>(),
  selectedProc: null as string | null,
  dests: new Map<string, Dest>(),
  selectedDest: null as string | null,
  traces: new Map<string, Trace>(), // key: destination ip
  geo: new Map<string, Geo>(),
  home: null as { lat: number; lng: number; label: string } | null,
  config: { relays: [] } as Config,
  relayMeasures: new Map<string, RelayMeasure>(),
  selectedRelay: null as string | null,
  inflight: 0,
  queue: [] as string[],
  filter: "",
  lastRefresh: 0,
  /** Destination ip to frame once its trace finishes. */
  pendingFit: null as string | null,
};

const MAX_CONCURRENT_TRACES = 3;
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
  const gone = (ip: string) => !live.has(ip) && ip !== sel;
  const cancelled = state.queue.filter(gone);
  state.queue = state.queue.filter((ip) => !gone(ip));
  for (const ip of cancelled) state.traces.delete(ip);
  const stale = [...state.traces.values()].filter((t) => t.done && gone(t.target)).sort((a, b) => a.startedAt - b.startedAt);
  const drop = stale.slice(0, Math.max(0, stale.length - MAX_STALE_TRACES));
  for (const t of drop) state.traces.delete(t.target);
  return cancelled.length + drop.length > 0;
}

/** Start a trace. `force` re-runs one that already finished; one still running is never doubled. */
function queueTrace(ip: string, force = false): void {
  const t = state.traces.get(ip);
  if (t && (!force || !t.done)) return;
  // A re-run keeps the finished route, so a worse answer this time cannot replace a good one.
  state.traces.set(ip, { id: ip, target: ip, hops: new Map(), done: false, startedAt: Date.now(), previous: t });
  state.queue.push(ip);
  pump();
}

function pump(): void {
  while (state.inflight < MAX_CONCURRENT_TRACES && state.queue.length) {
    const ip = state.queue.shift()!;
    state.inflight++;
    api.call("trace", { id: ip, target: ip, maxHops: 25 }).catch((e) => {
      const t = state.traces.get(ip);
      if (t) Object.assign(t, { done: true, error: String(e) });
      state.inflight--;
      pump();
    });
  }
  const n = state.inflight;
  setStatus(n ? `tracing ${n} route${n > 1 ? "s" : ""}${state.queue.length ? `, ${state.queue.length} queued` : ""}` : idleStatus(), n > 0);
}

function wireEvents(): void {
  api.on<HopEvent>("trace:hop", (p) => {
    const t = state.traces.get(p.id);
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
    const t = state.traces.get(p.id);
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
    renderDests();
    draw();
  });
  api.on<DoneEvent>("trace:done", async (p) => {
    const t = state.traces.get(p.id);
    if (t) {
      t.done = true;
      if (!p.ok) t.error = p.error ?? "failed";
      keepBetterRun(t);
    }
    state.inflight = Math.max(0, state.inflight - 1);
    pump();
    if (t) await geolocateTrace(t);
    renderDests();
    if (p.id === selectedIp()) {
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

async function geolocateTrace(t: Trace): Promise<void> {
  // The destination is located even when it never answers, so relay estimates can aim at it.
  const ips = [...new Set([...[...t.hops.values()].map((h) => h.ip), t.target])].filter((ip): ip is string => !!ip && !isPrivateIp(ip) && !state.geo.has(ip));
  if (!ips.length) return;
  try {
    for (const g of await api.call<Geo[]>("geolocate", { ips })) if (g.status === "success") state.geo.set(g.query, g);
    locateHops(t);
  } catch (e) {
    setStatus(`geolocation failed: ${String(e)}`);
  }
}

function locateHops(t: Trace): void {
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
      if (state.home) Object.assign(h, { lat: state.home.lat, lng: state.home.lng, place: "Home network", source: "home" });
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
    if (ok) Object.assign(h, ok);
    else if (cands.length) {
      Object.assign(h, { lat: undefined, lng: undefined, source: undefined, place: `${cands[0].place}? Too far for ${best!.toFixed(0)} ms`, implausible: cands[0].place });
    }
  }
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

const geoPlace = (g: Geo, fallback: string): string => [g.city, g.regionName].filter(Boolean).join(", ") || g.country || fallback;

function minRtt(rtts: (number | null)[]): number | undefined {
  const good = rtts.filter((v): v is number => v != null);
  return good.length ? Math.min(...good) : undefined;
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
  renderRank(ranked);
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
  const t = state.traces.get(d.ip);
  queueTrace(d.ip, again);
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
    ol.innerHTML = `<li class="empty">Hops appear here as the trace runs.</li>`;
    return;
  }
  const hops = [...t.hops.values()].sort((a, b) => a.hop - b.hop);
  const last = hops.filter((h) => h.avg != null).pop();
  $("routeTarget").textContent = t.target;
  $("routeTotal").innerHTML = last?.avg != null ? `${last.avg.toFixed(0)}<small>ms</small>` : t.done ? `<small>no reply</small>` : "…";
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
  $("routeStats").innerHTML = `<div><b>${hops.length}</b><span>hops</span></div><div><b>${pathKm ? pathKm.toFixed(0) : "—"}</b><span>km path</span></div><div><b>${direct ? direct.toFixed(0) : "—"}</b><span>km direct</span></div>`;
  $("routeMeta").innerHTML =
    (end ? `Ends near <b>${esc(end.place ?? "")}</b>` : t.done ? "No located hop replied" : "Tracing") +
    (detours ? `<span class="chip">${detours} backwards</span>` : "") +
    (t.error ? `<br>${esc(t.error)}` : "") +
    (t.note ? `<br>${esc(t.note)}` : "");
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
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
    li.innerHTML = `<span class="ms ${h.avg == null ? "none" : ""}">${ms}</span><div><div class="where">${esc(h.place ?? (h.ip ? "Locating" : "No reply"))}${h.detour ? `<span class="flag">backwards</span>` : ""}</div><div class="who">${esc(h.rdns ?? h.ip ?? `hop ${h.hop}`)}</div></div>`;
    if (located) li.addEventListener("click", () => globe.flyTo(h.lat!, h.lng!, 0.6));
    ol.appendChild(li);
  }
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
      draw();
    });
    row.querySelector<HTMLButtonElement>(".x")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      state.config.relays = state.config.relays.filter((x) => x !== m.relay);
      state.relayMeasures.delete(m.relay.host);
      await saveConfig();
      rankRelays();
      draw();
    });
    el.appendChild(row);
  }
}

// ---------- rendering: globe ----------

function routePoints(t: Trace | undefined): { lat: number; lng: number }[] {
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

  for (const t of state.traces.values()) {
    const isSel = t.target === sel;
    const hops = [...t.hops.values()].sort((a, b) => a.hop - b.hop).filter((h) => h.lat != null && h.lng != null);
    const end = hops.filter((h) => h.source !== "home").pop();
    // Every route leaves from this machine, even when the gateway does not answer.
    let prev: Hop | undefined = state.home ? { hop: 0, ip: null, rtts: [], avg: null, lat: state.home.lat, lng: state.home.lng, place: state.home.label, source: "home" } : undefined;
    for (const h of hops) {
      if (prev && (prev.lat !== h.lat || prev.lng !== h.lng)) {
        arcs.push({ sLat: prev.lat!, sLng: prev.lng!, eLat: h.lat!, eLng: h.lng!, color: isSel ? "#d0d0d0" : "#303030", stroke: 0, alt: isSel ? 0.08 : 0.04, dash: isSel, label: `<b>${esc(t.target)}</b> hop ${h.hop}<br><span class="m">${esc(prev.place ?? "")} → ${esc(h.place ?? "")}${h.avg != null ? ` · ${h.avg.toFixed(0)} ms` : ""}</span>` });
      }
      if (h.source !== "home") addPoint(h.lat!, h.lng!, h.place ?? h.ip ?? "", `${esc(t.target)} hop ${h.hop}${h.avg != null ? ` · ${h.avg.toFixed(0)} ms` : ""}${h.rdns ? `<br>${esc(h.rdns)}` : ""}`, "hop", isSel, isSel ? h.place : undefined, h === end ? 2 : 3);
      prev = h;
    }
  }

  // Best relay route: home → relay → destination, white and solid, onward leg fades to mark the estimate.
  const end = routeEnd(selectedTrace());
  const relay = state.selectedRelay ? state.relayMeasures.get(state.selectedRelay) : undefined;
  if (state.home && end && relay && relay.lat != null && relay.lng != null && relay.total != null) {
    arcs.push({ sLat: state.home.lat, sLng: state.home.lng, eLat: relay.lat, eLng: relay.lng, color: "#ffffff", stroke: 0, alt: 0.14, dash: false, label: `<b>via ${esc(relay.relay.name)}</b><br><span class="m">${relay.rtt!.toFixed(0)} ms measured to relay</span>` });
    arcs.push({ sLat: relay.lat, sLng: relay.lng, eLat: end.lat, eLng: end.lng, color: ["#ffffff", "rgba(255,255,255,0.3)"], stroke: 0, alt: 0.14, dash: false, label: `<b>${esc(relay.relay.name)} → ${esc(end.place)}</b><br><span class="m">~${relay.legEst!.toFixed(0)} ms estimated from distance</span>` });
    addPoint(relay.lat, relay.lng, relay.relay.name, `relay · ${relay.rtt!.toFixed(0)} ms from here`, "relay", true, relay.relay.name, 1);
  }

  globe.setData(arcs, [...points.values()], wants);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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
