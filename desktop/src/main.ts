import { createBackend, type Backend } from "./backend";
import { RouteGlobe, type ArcDatum, type PointDatum, type RingDatum } from "./globe";
import { estimateLegMs, haversineKm, isPrivateIp, placeFromRdns } from "./geo";
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
};

const MAX_CONCURRENT_TRACES = 3;
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
    renderProcs();
    rebuildDests();
  } catch (e) {
    setStatus(`connections unavailable: ${String(e)}`);
  }
}

function rebuildDests(): void {
  const list = state.selectedProc ? state.procs.get(state.selectedProc) ?? [] : state.conns;
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

function queueTrace(ip: string): void {
  if (state.traces.has(ip)) return;
  state.traces.set(ip, { id: ip, target: ip, hops: new Map(), done: false, startedAt: Date.now() });
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
  setStatus(n ? `tracing ${n} route${n > 1 ? "s" : ""}${state.queue.length ? `, ${state.queue.length} queued` : ""}` : `${state.conns.length} connections · live`, n > 0);
}

function wireEvents(): void {
  api.on<HopEvent>("trace:hop", (p) => {
    const t = state.traces.get(p.id);
    if (!t) return;
    const prev = t.hops.get(p.hop);
    t.hops.set(p.hop, { ...prev, hop: p.hop, ip: p.ip, rtts: p.rtts, avg: p.avg });
    locateHops(t);
    if (p.id === selectedIp()) renderRoute();
    renderDests();
    draw();
  });
  api.on<RdnsEvent>("trace:rdns", (p) => {
    const t = state.traces.get(p.id);
    const h = t?.hops.get(p.hop);
    if (!t || !h) return;
    h.rdns = p.name;
    locateHops(t);
    if (p.id === selectedIp()) renderRoute();
    renderDests();
    draw();
  });
  api.on<DoneEvent>("trace:done", async (p) => {
    const t = state.traces.get(p.id);
    if (t) {
      t.done = true;
      if (!p.ok) t.error = p.error ?? "failed";
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
  });
}

async function geolocateTrace(t: Trace): Promise<void> {
  const ips = [...t.hops.values()].map((h) => h.ip).filter((ip): ip is string => !!ip && !isPrivateIp(ip) && !state.geo.has(ip));
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
  for (const h of hops) {
    if (!h.ip || isPrivateIp(h.ip)) {
      if (state.home) Object.assign(h, { lat: state.home.lat, lng: state.home.lng, place: h.ip ? "Home network" : "No reply", source: "home" });
      continue;
    }
    const p = h.rdns ? placeFromRdns(h.rdns) : undefined;
    if (p) Object.assign(h, { lat: p.lat, lng: p.lng, place: p.name, source: "rdns" });
    else {
      const g = state.geo.get(h.ip);
      if (g && g.lat != null && g.lon != null) Object.assign(h, { lat: g.lat, lng: g.lon, place: [g.city, g.regionName].filter(Boolean).join(", ") || g.country || h.ip, source: "geo" });
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
      if (m.lat == null && !isPrivateIp(r.host) && /^[\d.:a-f]+$/i.test(r.host)) {
        const g = (await api.call<Geo[]>("geolocate", { ips: [r.host] }))[0];
        if (g?.status === "success" && g.lat != null && g.lon != null) Object.assign(m, { lat: g.lat, lng: g.lon });
      }
      state.relayMeasures.set(r.host, m);
    } catch {
      state.relayMeasures.set(r.host, { relay: r, rtt: null });
    }
    rankRelays();
    draw();
  }
}

function rankRelays(): RelayMeasure[] {
  const t = selectedTrace();
  const end = t ? [...t.hops.values()].filter((h) => h.lat != null && h.source !== "home").pop() : undefined;
  const ranked: RelayMeasure[] = [];
  for (const r of state.config.relays) {
    const m = state.relayMeasures.get(r.host) ?? { relay: r, rtt: null };
    if (m.rtt != null && end && m.lat != null && m.lng != null) {
      m.legEst = estimateLegMs(haversineKm(m.lat, m.lng, end.lat!, end.lng!));
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

function renderProcs(): void {
  const ul = $("procs");
  ul.innerHTML = "";
  const rows = [...state.procs.entries()].filter(([n]) => matches(n)).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const max = Math.max(1, ...rows.map(([, l]) => l.length));
  if (!rows.length) {
    ul.innerHTML = `<li class="empty">${state.filter ? "No process matches" : "No outbound connections"}</li>`;
    return;
  }
  for (const [name, list] of rows) {
    const li = document.createElement("li");
    li.setAttribute("aria-selected", String(state.selectedProc === name));
    const focused = state.config.focus === name;
    li.innerHTML = `<span class="primary">${esc(name)}</span><span class="secondary">${list.length}</span><button class="pin" type="button" aria-pressed="${focused}" title="${focused ? "Focused: every destination is traced automatically" : "Focus this process"}">${focused ? "●" : "○"}</button><span class="bar"><i style="width:${Math.round((list.length / max) * 100)}%"></i></span>`;
    li.addEventListener("click", () => {
      state.selectedProc = state.selectedProc === name ? null : name;
      renderProcs();
      rebuildDests();
    });
    li.querySelector<HTMLButtonElement>(".pin")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      state.config.focus = focused ? null : name;
      await saveConfig();
      renderProcs();
      rebuildDests();
    });
    ul.appendChild(li);
  }
}

function renderDests(): void {
  const ul = $("dests");
  $("destLabel").textContent = state.selectedProc ? `Destinations · ${state.selectedProc}` : "Destinations · all";
  ul.innerHTML = "";
  const rows = [...state.dests.values()].filter((d) => matches(d.ip) || [...d.processes].some(matches)).sort((a, b) => b.count - a.count || a.ip.localeCompare(b.ip));
  if (!rows.length) {
    ul.innerHTML = `<li class="empty">${state.filter ? "No destination matches" : "Nothing outbound right now"}</li>`;
    return;
  }
  for (const d of rows) {
    const t = state.traces.get(d.ip);
    const hops = t ? [...t.hops.values()] : [];
    const last = hops.filter((h) => h.avg != null).pop();
    const far = hops.filter((h) => h.place && h.source !== "home").pop();
    const ms = last?.avg != null ? `${last.avg.toFixed(0)} ms` : t ? (t.done ? "no reply" : "…") : "";
    const svc = service(d.port);
    const li = document.createElement("li");
    li.setAttribute("aria-selected", String(state.selectedDest === d.key));
    li.innerHTML =
      `<span class="primary"><span class="dot ${t ? (t.done ? "done" : "tracing") : ""}"></span>${esc(d.ip)}<span style="color:var(--ink-3)">:${d.port}</span>${svc ? `<span class="tag">${svc}</span>` : ""}</span>` +
      `<span class="secondary ${t?.done ? "live" : ""}">${ms}</span>` +
      `<span class="sub">${d.proto} · ${[...d.processes].map(esc).join(", ")}${far?.place ? ` · ${esc(far.place)}` : ""}</span>`;
    li.addEventListener("click", () => {
      state.selectedDest = d.key;
      state.selectedRelay = null;
      queueTrace(d.ip);
      renderDests();
      renderRoute();
      rankRelays();
      draw();
      const pts = routePoints(state.traces.get(d.ip));
      if (pts.length > 1) globe.fitPoints(pts);
    });
    ul.appendChild(li);
  }
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
    (t.error ? `<br>${esc(t.error)}` : "");
  for (const h of hops) {
    const li = document.createElement("li");
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
  const current = t ? [...t.hops.values()].filter((h) => h.avg != null).pop()?.avg : undefined;
  if (!ranked.length) {
    el.innerHTML = `<div class="empty">No relays yet. Add a VPS, a Tailscale exit node or a gaming-VPN node to compare it against the current path.</div>`;
    return;
  }
  for (const m of ranked) {
    const row = document.createElement("div");
    row.className = "r";
    row.setAttribute("aria-selected", String(state.selectedRelay === m.relay.host));
    const delta = m.total != null && current != null ? m.total - current : undefined;
    const right = m.total != null ? `~${m.total.toFixed(0)} ms` : m.rtt != null ? `${m.rtt.toFixed(0)} ms` : state.relayMeasures.has(m.relay.host) ? "no reply" : "…";
    const detail =
      m.rtt == null
        ? esc(m.relay.host)
        : `${m.rtt.toFixed(0)} ms to relay` + (m.legEst != null ? ` + ~${m.legEst.toFixed(0)} ms onward` : t ? " · destination not located" : " · pick a destination") + (delta != null ? ` <span class="delta">${delta <= 0 ? "" : "+"}${delta.toFixed(0)} ms vs now</span>` : "");
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
  const rings: RingDatum[] = [];
  const sel = selectedIp();

  const labeled: { lat: number; lng: number }[] = [];
  const addPoint = (lat: number, lng: number, label: string, detail: string, radius: number, color: string, text?: string) => {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const ex = points.get(key);
    if (ex) {
      if (!ex.detail.includes(detail)) ex.detail += `<br>${detail}`;
      ex.radius = Math.max(ex.radius, radius);
      if (color === "#ffffff") ex.color = color;
      return;
    }
    // One label per 60 km, so a cluster of metro routers reads as one place.
    if (text && labeled.some((p) => haversineKm(p.lat, p.lng, lat, lng) < 60)) text = undefined;
    if (text) labeled.push({ lat, lng });
    points.set(key, { lat, lng, label, detail, radius, color, text });
  };

  if (state.home) {
    addPoint(state.home.lat, state.home.lng, state.home.label, "This machine", 0.09, "#ffffff", state.home.label);
    rings.push({ lat: state.home.lat, lng: state.home.lng });
  }

  for (const t of state.traces.values()) {
    const isSel = t.target === sel;
    const hops = [...t.hops.values()].sort((a, b) => a.hop - b.hop).filter((h) => h.lat != null && h.lng != null);
    let prev: Hop | undefined;
    for (const h of hops) {
      if (prev && (prev.lat !== h.lat || prev.lng !== h.lng)) {
        arcs.push({ sLat: prev.lat!, sLng: prev.lng!, eLat: h.lat!, eLng: h.lng!, color: isSel ? "#d0d0d0" : "#303030", stroke: 0, alt: isSel ? 0.08 : 0.04, dash: isSel, label: `<b>${esc(t.target)}</b> hop ${h.hop}<br><span class="m">${esc(prev.place ?? "")} → ${esc(h.place ?? "")}${h.avg != null ? ` · ${h.avg.toFixed(0)} ms` : ""}</span>` });
      }
      if (h.source !== "home") addPoint(h.lat!, h.lng!, h.place ?? h.ip ?? "", `${esc(t.target)} hop ${h.hop}${h.avg != null ? ` · ${h.avg.toFixed(0)} ms` : ""}${h.rdns ? `<br>${esc(h.rdns)}` : ""}`, isSel ? 0.07 : 0.035, isSel ? "#ffffff" : "#4a4a4a", isSel ? h.place : undefined);
      prev = h;
    }
  }

  // Best relay route: home → relay → destination, white and solid, onward leg fades to mark the estimate.
  const t = selectedTrace();
  const end = t ? [...t.hops.values()].filter((h) => h.lat != null && h.source !== "home").pop() : undefined;
  const relay = state.selectedRelay ? state.relayMeasures.get(state.selectedRelay) : undefined;
  if (state.home && end && relay && relay.lat != null && relay.lng != null && relay.total != null) {
    arcs.push({ sLat: state.home.lat, sLng: state.home.lng, eLat: relay.lat, eLng: relay.lng, color: "#ffffff", stroke: 0, alt: 0.14, dash: false, label: `<b>via ${esc(relay.relay.name)}</b><br><span class="m">${relay.rtt!.toFixed(0)} ms measured to relay</span>` });
    arcs.push({ sLat: relay.lat, sLng: relay.lng, eLat: end.lat!, eLng: end.lng!, color: ["#ffffff", "rgba(255,255,255,0.3)"], stroke: 0, alt: 0.14, dash: false, label: `<b>${esc(relay.relay.name)} → ${esc(end.place ?? "")}</b><br><span class="m">~${relay.legEst!.toFixed(0)} ms estimated from distance</span>` });
    addPoint(relay.lat, relay.lng, relay.relay.name, `relay · ${relay.rtt!.toFixed(0)} ms from here`, 0.09, "#ffffff", relay.relay.name);
  }

  globe.setData(arcs, [...points.values()], rings);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------- wiring ----------

function wireUi(): void {
  $<HTMLInputElement>("filter").addEventListener("input", (e) => {
    state.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
    renderProcs();
    renderDests();
  });
  $("traceAll").addEventListener("click", () => {
    for (const d of state.dests.values()) queueTrace(d.ip);
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
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r: Relay = { name: $<HTMLInputElement>("relayName").value.trim(), host: $<HTMLInputElement>("relayHost").value.trim() };
    if (!r.name || !r.host) return;
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
    if (first) {
      state.selectedDest = first.key;
      renderDests();
      renderRoute();
    }
  }
  void measureRelays();
  setInterval(() => void refreshConnections(), 4000);
  setInterval(() => void measureRelays(), 60000);
  setStatus(`${state.conns.length} connections · live${api.mock ? " · replay data" : ""}`);
}

void boot();
