// Relay tunnel section: import the WireGuard config from rig-relay-add-peer, turn the tunnel
// on and off, and show whether it is handshaking and how fast the relay answers.

import type { Backend } from "./backend";
import type { PingStats } from "./types";

export interface RelaySummary {
  /** The saved relay's name. */
  name: string | null;
  endpoint: string;
  address: string;
  peer_key: string;
  allowed_ips: number;
  probe: string | null;
  keepalive: number | null;
}

export type TunnelState = "down" | "starting" | "up" | "stopping" | "degraded";

export interface RelayStatus {
  installed: boolean;
  imported: boolean;
  /** The tunnel's relay, by saved name. */
  name: string | null;
  /** Relays saved for Auto, the tunnel's included. */
  saved: number;
  state: TunnelState;
  endpoint: string | null;
  handshake_age_s: number | null;
  rx_bytes: number | null;
  tx_bytes: number | null;
  /** One echo to the relay through the tunnel, sent when the handshake can't be read. */
  probe_ms: number | null;
  detail: string | null;
}

/** "12 s ago", "3 min ago". WireGuard re-handshakes every 2 minutes, so over 3 minutes is stale. */
export function handshakeText(age: number | null | undefined): string {
  if (age == null) return "no handshake yet";
  if (age < 60) return `handshake ${age} s ago`;
  return `handshake ${Math.floor(age / 60)} min ago${age > 180 ? " (stale)" : ""}`;
}

const STATE_TEXT: Record<TunnelState, string> = { down: "Off", starting: "Starting", up: "On", stopping: "Stopping", degraded: "Partly on" };

export type PathKind = "direct" | "relay";

export interface PathScore {
  sent: number;
  received: number;
  loss: number;
  median: number | null;
  p95_jitter: number | null;
  score: number | null;
  eligible: boolean;
}

export interface HostScore {
  target: string;
  score: PathScore;
}

export interface PathResult {
  candidate: { id: string; kind: PathKind; label: string; endpoint: string | null };
  score: PathScore | null;
  /** The same pings split by target, in the run's target order. */
  hosts: HostScore[];
  floor_ms: number | null;
  note: string | null;
}

export interface AutoResult {
  targets: string[];
  /** The live game server among targets, when one answered ping. */
  live: string | null;
  paths: PathResult[];
  /** live: the game server whose measurement alone decided, when it did. */
  /** vs: the relay direct was judged against. */
  pick: { id: string; gain_ms: number | null; reason: string; live: string | null; vs: string | null };
  min_gain_ms: number;
  switches: number;
  applied: boolean;
  started_at: number;
  finished_at: number;
  error: string | null;
  /** The record the backend judged and saved for this run. Missing without a relay to compare. */
  record?: import("./proof").JudgedRecord;
  /** Why the record could not be saved, when it could not. */
  log_error?: string;
}

export interface CheckResult {
  path: string;
  score: PathScore;
  recheck: string | null;
}

export interface AutoProgress {
  phase: string;
  done: number;
  total: number;
}

/** One line of numbers for a scored path. */
export function pathLine(p: PathResult): string {
  const s = p.score;
  if (!s) return p.note ?? "not measured";
  if (s.median == null) return `no replies (${s.sent} sent)`;
  const parts = [`${Math.round(s.median)} ms median`, `p95 jitter ${Math.round(s.p95_jitter ?? 0)} ms`, `${Math.round(s.loss * 100)}% loss`];
  return parts.join(" · ") + (s.eligible ? "" : " · too few replies");
}

/**
 * One row per target: each path's score there, and the best relay's saving over direct. The pick
 * is made per host, so this is the table it was made from.
 */
export function hostRows(a: AutoResult): { target: string; live: boolean; cells: (number | null)[]; saved: number | null }[] {
  const direct = a.paths.find((p) => p.candidate.kind === "direct");
  const at = (p: PathResult, t: string) => {
    const s = p.hosts?.find((h) => h.target === t)?.score;
    return s?.eligible && s.score != null ? s.score : null;
  };
  return a.targets.map((t) => {
    const cells = a.paths.map((p) => at(p, t));
    const d = direct ? at(direct, t) : null;
    const relays = a.paths.filter((p) => p.candidate.kind === "relay").map((p) => at(p, t)).filter((v): v is number => v != null);
    const saved = d != null && relays.length ? d - Math.min(...relays) : null;
    return { target: t, live: t === a.live, cells, saved };
  });
}

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* per-viewer convenience only */
    }
  },
};

/** How often Auto checks the path it picked, without switching anything. */
const CHECK_EVERY_MS = 60_000;

export interface RelayOptions {
  /** The live League game server, when a match is on, so probes aim at the real endpoint. */
  gameTarget?: () => string | null;
  /** Called with every finished Auto run, so it lands in the proof log. */
  onAuto?: (result: AutoResult) => void;
}

export function mountRelay(api: Backend, root: HTMLElement, opts: RelayOptions = {}): { refresh: () => Promise<void> } {
  root.innerHTML = `
    <div class="label"><span>Relay</span><span class="num" data-r="state">Off</span></div>
    <div class="relay-row">
      <div class="seg" role="group" aria-label="Relay mode">
        <button class="btn" type="button" data-r="manual" aria-pressed="true">Manual</button>
        <button class="btn" type="button" data-r="auto" aria-pressed="false" title="Measure direct and every relay to the game server, use the best">Auto</button>
      </div>
    </div>
    <div class="relay-row">
      <div class="seg" role="group" aria-label="Relay tunnel" data-r="tunnelSeg">
        <button class="btn" type="button" data-r="on" disabled>On</button>
        <button class="btn" type="button" data-r="off" disabled>Off</button>
      </div>
      <button class="btn" type="button" data-r="test" disabled>Test</button>
      <label class="btn ghost relay-file">Import<span class="relay-wide"> config</span><input type="file" accept=".conf,text/plain" hidden data-r="file" /></label>
    </div>
    <div class="relay-auto" data-r="autoBox" hidden>
      <div class="relay-row">
        <button class="btn" type="button" data-r="run">Find best path</button>
        <span class="num" data-r="prog"></span>
      </div>
      <ul class="list" data-r="paths" aria-label="Paths ranked by score"></ul>
      <table class="relay-hosts" data-r="hosts" aria-label="Score per host" hidden></table>
      <div class="foot" data-r="pick"></div>
    </div>
    <div class="foot" data-r="info"></div>
    <div class="foot relay-err" data-r="err" hidden></div>`;
  const $ = <T extends HTMLElement>(k: string) => root.querySelector<T>(`[data-r="${k}"]`)!;
  const stateEl = $("state");
  const file = $<HTMLInputElement>("file");
  const on = $<HTMLButtonElement>("on");
  const off = $<HTMLButtonElement>("off");
  const test = $<HTMLButtonElement>("test");
  const info = $("info");
  const err = $("err");
  const manualBtn = $<HTMLButtonElement>("manual");
  const autoBtn = $<HTMLButtonElement>("auto");
  const autoBox = $("autoBox");
  const tunnelSeg = $("tunnelSeg");
  const runBtn = $<HTMLButtonElement>("run");
  const prog = $("prog");
  const pathsEl = $("paths");
  const pickEl = $("pick");
  const hostsEl = $<HTMLTableElement>("hosts");

  let auto = store.get("relay.mode") === "auto";
  let result: AutoResult | undefined;
  let recheck: string | null = null;
  let checking = false;

  let status: RelayStatus | undefined;
  let latency = "";
  let busy = false;
  // After a failed start the tunnel may be half up while its state reads "down", so Off stays live.
  let upFailed = false;

  const showErr = (e: unknown) => {
    err.textContent = e ? String(e) : "";
    err.hidden = !e;
  };

  const render = () => {
    const s = status;
    stateEl.textContent = s ? STATE_TEXT[s.state] : "…";
    stateEl.classList.toggle("relay-on", s?.state === "up");
    const ready = !!s && s.installed && s.imported;
    on.disabled = busy || !s || !ready || s.state !== "down";
    // Off works whenever WireGuard is installed and something may be up: it is the way out.
    off.disabled = busy || !s?.installed || (s.state === "down" && !upFailed);
    on.setAttribute("aria-pressed", String(s?.state === "up"));
    off.setAttribute("aria-pressed", String(!!s && s.state === "down"));
    test.disabled = busy || s?.state !== "up";
    const lines: string[] = [];
    if (s?.endpoint) lines.push(`Relay ${s.name ?? ""} ${s.endpoint}`.replace("  ", " "));
    if (s && s.saved > 1) lines.push(`${s.saved} relays saved, Auto tries each`);
    if (s?.state === "up" && s.handshake_age_s != null) lines.push(handshakeText(s.handshake_age_s));
    else if (s?.state === "up" && s.probe_ms != null) lines.push(`relay answering in ${Math.round(s.probe_ms)} ms`);
    else if (s?.state === "up" && !s.detail) lines.push(handshakeText(null));
    if (latency && s?.state === "up") lines.push(latency);
    if (s && !s.imported) lines.push("Import the relay config file (.conf) you were sent.");
    if (s?.detail) lines.push(s.detail);
    info.textContent = lines.join(" · ");
    renderAuto();
  };

  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

  function renderAuto(): void {
    manualBtn.setAttribute("aria-pressed", String(!auto));
    autoBtn.setAttribute("aria-pressed", String(auto));
    autoBox.hidden = !auto;
    // Auto owns the tunnel: the manual On/Off only shows in Manual, so there is one control in charge.
    tunnelSeg.hidden = auto;
    runBtn.disabled = busy || !status || (status.imported && !status.installed);
    if (!auto) return;
    if (!result) {
      hostsEl.hidden = true;
      pathsEl.innerHTML = `<li class="empty">Measures direct and each relay to the game server, then uses the fastest. ${status?.imported ? "Switches the tunnel once or twice per relay." : "Import a relay config to compare a relay path."}</li>`;
      pickEl.textContent = "";
      return;
    }
    pathsEl.innerHTML = result.paths
      .map((p) => {
        const picked = p.candidate.id === result!.pick.id;
        const sc = p.score?.eligible && p.score.score != null ? `${Math.round(p.score.score)}` : "–";
        return `<li aria-selected="${picked}" data-path="${esc(p.candidate.id)}"><span>${esc(p.candidate.label)}${picked ? " · picked" : ""}</span><span class="secondary${picked ? " live" : ""}" title="Lower is better: median ping with jitter and loss added as penalties">score ${sc}</span><span class="sub">${esc(pathLine(p))}</span></li>`;
      })
      .join("");
    const rows = hostRows(result);
    hostsEl.hidden = rows.length === 0 || result.paths.length < 2;
    const ms = (v: number | null) => (v == null ? "–" : `${Math.round(v)}`);
    const signed = (v: number | null) => (v == null ? "–" : `${v < 0 ? "−" : ""}${Math.abs(Math.round(v))}`);
    hostsEl.innerHTML =
      `<thead><tr><th scope="col">Host</th>${result.paths.map((p) => `<th scope="col">${esc(p.candidate.label)}</th>`).join("")}<th scope="col" title="Direct minus the best relay, in ms. Positive means the relay is faster.">Saved</th></tr></thead>` +
      `<tbody>${rows
        .map(
          (r) =>
            `<tr${r.live ? ' class="live"' : ""}><th scope="row">${esc(r.target)}${r.live ? " · game" : ""}</th>${r.cells.map((c) => `<td>${ms(c)}</td>`).join("")}<td class="${r.saved != null && r.saved >= result!.min_gain_ms ? "win" : ""}">${signed(r.saved)}</td></tr>`,
        )
        .join("")}</tbody>`;
    const when = new Date(result.finished_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const notes = [result.pick.reason, result.pick.live ? "The game server decides alone." : "Without a game server, a relay must win on most hosts.", `Lower score is better. Switches only for a gain of ${result.min_gain_ms} ms or more.`, `${result.switches} tunnel switch${result.switches === 1 ? "" : "es"}, ${when}.`];
    if (!result.applied) notes.push("The tunnel is not on the picked path.");
    if (result.error) notes.push(result.error);
    if (recheck) notes.push(`Re-check suggested: ${recheck}`);
    pickEl.textContent = notes.join(" ");
  }

  const targets = (): string[] => {
    const live = opts.gameTarget?.() ?? null;
    if (live) store.set("relay.gameTarget", live);
    const last = live ?? store.get("relay.gameTarget");
    return last ? [last] : [];
  };

  const refresh = async () => {
    try {
      status = await api.call<RelayStatus>("relay_status");
    } catch (e) {
      showErr(e);
    }
    render();
  };

  const run = async (f: () => Promise<void>) => {
    busy = true;
    showErr(null);
    render();
    try {
      await f();
    } catch (e) {
      showErr(e);
    }
    busy = false;
    await refresh();
  };

  file.addEventListener("change", () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    void run(async () => {
      const text = await f.text();
      await api.call<RelaySummary>("relay_import", { text, name: f.name.replace(/\.conf$/i, "") });
      latency = "";
    });
  });

  on.addEventListener("click", () =>
    void run(async () => {
      latency = "";
      upFailed = true;
      status = await api.call<RelayStatus>("relay_up");
      upFailed = false;
    }),
  );

  off.addEventListener("click", () =>
    void run(async () => {
      latency = "";
      status = await api.call<RelayStatus>("relay_down");
      upFailed = false;
    }),
  );

  test.addEventListener("click", () =>
    void run(async () => {
      const p = await api.call<PingStats>("relay_ping", { count: 10 });
      latency = p.avg == null ? `relay ${p.host} did not answer` : `relay ${Math.round(p.avg)} ms, ${p.sent - p.received}/${p.sent} lost`;
    }),
  );

  const setMode = (a: boolean) => {
    auto = a;
    store.set("relay.mode", a ? "auto" : "manual");
    render();
  };
  manualBtn.addEventListener("click", () => setMode(false));
  autoBtn.addEventListener("click", () => setMode(true));

  api.on<AutoProgress>("auto:progress", (p) => {
    if (busy) prog.textContent = `${p.phase === "direct" ? "Direct" : p.phase} ${p.done}/${p.total}`;
  });

  runBtn.addEventListener("click", () =>
    void run(async () => {
      recheck = null;
      prog.textContent = "Starting";
      try {
        result = await api.call<AutoResult>("route_auto", { targets: targets(), apply: true });
        opts.onAuto?.(result);
      } finally {
        prog.textContent = "";
      }
    }),
  );

  // Light check of the picked path: a few pings, nothing switched, so it is safe mid-match.
  const check = async () => {
    if (!auto || !result || busy || checking) return;
    const current = status?.state === "up" ? "relay" : "direct";
    const picked = result.paths.find((p) => p.candidate.id === result!.pick.id);
    if (!picked || picked.candidate.kind !== current) return;
    if (current === "relay" && status?.name && status.name !== picked.candidate.id) return;
    checking = true;
    try {
      const c = await api.call<CheckResult>("route_check", {
        targets: targets().length ? targets() : result.targets,
        ageS: Math.round((Date.now() - result.finished_at) / 1000),
        baselineMedian: picked.score?.median ?? null,
      });
      recheck = c.recheck;
      render();
    } catch {
      /* a failed check leaves the last state */
    }
    checking = false;
  };

  void refresh();
  setInterval(() => {
    if (!busy) void refresh();
  }, 5000);
  setInterval(() => void check(), CHECK_EVERY_MS);
  return { refresh };
}
