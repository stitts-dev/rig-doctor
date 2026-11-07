// Relay tunnel section: import the WireGuard config from rig-relay-add-peer, turn the tunnel
// on and off, and show whether it is handshaking and how fast the relay answers.

import type { Backend } from "./backend";
import type { PingStats } from "./types";
import type { MatchPing } from "./proof";

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
  /** League's client phase when a switch could hit it, such as "in champ select". */
  client_phase?: string | null;
  /** What the picked game is doing when a route change could drop it, from the backend's process check. */
  game_state?: string | null;
  /** Only on the answer to On or Connect: switched while the game was in a match. */
  warning?: string | null;
}

/** "12 s ago", "3 min ago". WireGuard re-handshakes every 2 minutes, so over 3 minutes is stale. */
export function handshakeText(age: number | null | undefined): string {
  if (age == null) return "no handshake yet";
  if (age < 60) return `handshake ${age} s ago`;
  return `handshake ${Math.floor(age / 60)} min ago${age > 180 ? " (stale)" : ""}`;
}

/** The game watched when none is picked. Matches the backend's DEFAULT_GAME. */
export const DEFAULT_GAME = "League of Legends";

/** Common games by the process name their match runs as, without ".exe". */
export const GAME_PRESETS: { label: string; process: string }[] = [
  { label: "League of Legends", process: "League of Legends" },
  { label: "Valorant", process: "VALORANT-Win64-Shipping" },
  { label: "Counter-Strike 2", process: "cs2" },
  { label: "Fortnite", process: "FortniteClient-Win64-Shipping" },
];

const normProcess = (n: string) => n.trim().toLowerCase().replace(/\.exe$/, "");

/** Same rule as the backend's is_game_process: League means the match, not the client. */
export function isGameProcess(name: string, game: string): boolean {
  const n = normProcess(name);
  const g = normProcess(game);
  if (g.startsWith("league of legend")) return n.startsWith("league of legend");
  return n !== "" && (n === g || (n.length >= 15 && g.startsWith(n)));
}

/** The preset's name for a process, else the process name itself. */
export function gameLabel(process: string): string {
  return GAME_PRESETS.find((p) => normProcess(p.process) === normProcess(process))?.label ?? process;
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

/** Matches per path and the in-game score each was judged by (median ping plus loss penalty). */
export interface MatchCount {
  direct: number;
  relay: number;
  direct_ms: number | null;
  relay_ms: number | null;
}

export interface AutoResult {
  targets: string[];
  /** The live game server among targets, when one answered ping. */
  live: string | null;
  paths: PathResult[];
  /** live: the game server whose measurement alone decided, when it did. */
  /** vs: the relay direct was judged against. */
  pick: {
    id: string;
    gain_ms: number | null;
    reason: string;
    live: string | null;
    vs: string | null;
    /** Set when League's in-match ping decided: matches counted on direct and on `vs`, and each path's in-game score. */
    matches?: MatchCount;
  };
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
  /** The game to watch: the picked process, the running processes to offer, and how to save a pick. */
  game?: { current: () => string; running: () => string[]; set: (process: string) => void };
  /** The live game server, when a match is on, so probes aim at the real endpoint. */
  gameTarget?: () => string | null;
  /** Called with every finished Auto run, so it lands in the proof log. */
  onAuto?: (result: AutoResult) => void;
  /** Called with every tunnel status read, so the map and the Relays list can mark the relay in use. */
  onStatus?: (status: RelayStatus) => void;
  /** Called after a relay config is imported, so other lists can pick it up. */
  onRelaysChanged?: () => void;
}

export interface RelayUi {
  refresh: () => Promise<void>;
  /** Turns the tunnel on through saved relay `name`. */
  connect: (name: string) => Promise<void>;
  disconnect: () => void;
  busy: () => boolean;
  fillGames: () => void;
  /** League's own ping for the last match. */
  setMatch: (m: MatchPing | null) => void;
}

export function mountRelay(api: Backend, root: HTMLElement, opts: RelayOptions = {}): RelayUi {
  root.innerHTML = `
    <div class="label"><span>Relay</span><span class="num" data-r="state">Off</span></div>
    <ol class="flow" data-r="flow" aria-label="What Rig Doctor is doing now" aria-live="polite"></ol>
    <div class="relay-row">
      <div class="seg" role="group" aria-label="Relay mode">
        <button class="btn" type="button" data-r="manual" aria-pressed="true">Manual</button>
        <button class="btn" type="button" data-r="auto" aria-pressed="false" title="Measure direct and every relay to the game server, use the best">Auto</button>
      </div>
    </div>
    <div class="foot relay-hint" data-r="modeHint"></div>
    <div class="relay-row">
      <div class="seg relay-power" role="group" aria-label="Relay tunnel" data-r="tunnelSeg">
        <button class="btn" type="button" data-r="on" disabled>On</button>
        <button class="btn" type="button" data-r="off" disabled>Off</button>
      </div>
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
    <details class="relay-setup">
      <summary>Setup and testing</summary>
      <label class="relay-row relay-game" title="Auto never switches while this game is in a match, and aims at its server"><span>Game</span><select data-r="game" aria-label="Game to watch"></select></label>
      <div class="relay-row">
        <button class="btn" type="button" data-r="test" disabled>Test</button>
        <label class="btn ghost relay-file" data-r="fileBtn" title="Load the WireGuard .conf file for your relay">Import<span class="relay-wide"> config</span><input type="file" accept=".conf,text/plain" hidden data-r="file" /></label>
      </div>
      <form class="relay-row relay-join" data-r="joinForm" title="Paste the invite from rig-relay-invite. This PC makes its own key; the relay never sees it.">
        <input type="text" data-r="invite" placeholder="Paste a relay invite (rigrelay1.…)" aria-label="Relay invite" autocomplete="off" spellcheck="false" />
        <button class="btn ghost" type="submit" data-r="joinBtn" disabled>Join</button>
      </form>
    </details>
    <div class="foot" data-r="info"></div>
    <div class="foot" data-r="match" hidden></div>
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
  const flowEl = $("flow");
  const gameSel = $<HTMLSelectElement>("game");
  const modeHint = $("modeHint");
  const fileBtn = $("fileBtn");
  const joinForm = $<HTMLFormElement>("joinForm");
  const inviteIn = $<HTMLInputElement>("invite");
  const joinBtn = $<HTMLButtonElement>("joinBtn");
  gameSel.closest("label")!.hidden = !opts.game;

  /** Presets first, then running processes, so a game not listed can be picked while it runs. */
  const fillGames = () => {
    if (!opts.game) return;
    const cur = opts.game.current();
    const known = new Set(GAME_PRESETS.map((p) => normProcess(p.process)));
    const running = [...new Set(opts.game.running())].filter((n) => !known.has(normProcess(n))).sort((a, b) => a.localeCompare(b));
    if (!known.has(normProcess(cur)) && !running.some((n) => normProcess(n) === normProcess(cur))) running.unshift(cur);
    const opt = (value: string, label: string) => `<option value="${esc(value)}"${normProcess(value) === normProcess(cur) ? " selected" : ""}>${esc(label)}</option>`;
    gameSel.innerHTML =
      `<optgroup label="Games">${GAME_PRESETS.map((p) => opt(p.process, p.label)).join("")}</optgroup>` +
      (running.length ? `<optgroup label="Running now">${running.map((n) => opt(n, n)).join("")}</optgroup>` : "");
  };
  // The running list changes, so it is rebuilt each time the picker is opened.
  gameSel.addEventListener("focus", fillGames);
  gameSel.addEventListener("mousedown", fillGames);
  gameSel.addEventListener("change", () => {
    opts.game?.set(gameSel.value);
    // A server remembered for the last game is not this game's.
    store.set("relay.gameTarget", "");
  });

  let auto = store.get("relay.mode") === "auto";
  let result: AutoResult | undefined;
  let recheck: string | null = null;
  let checking = false;

  let status: RelayStatus | undefined;
  let latency = "";
  // Your own On or Connect is never refused mid-match. The warning stays up until the next action.
  let warning = "";
  let busy = false;
  // After a failed start the tunnel may be half up while its state reads "down", so Off stays live.
  let upFailed = false;

  const showErr = (e: unknown) => {
    err.textContent = e ? String(e) : "";
    err.hidden = !e;
  };

  const render = () => {
    const s = status;
    // Which path game traffic takes right now, not only whether the tunnel is up.
    stateEl.textContent = !s ? "…" : s.state === "up" && s.name ? `On · ${s.name}` : s.state === "down" ? "Off · direct" : STATE_TEXT[s.state];
    stateEl.classList.toggle("relay-on", s?.state === "up");
    const ready = !!s && s.installed && s.imported;
    on.disabled = busy || !s || !ready || s.state !== "down";
    // Off works whenever WireGuard is installed and something may be up: it is the way out.
    off.disabled = busy || !s?.installed || (s.state === "down" && !upFailed);
    on.setAttribute("aria-pressed", String(s?.state === "up"));
    off.setAttribute("aria-pressed", String(!!s && s.state === "down"));
    test.disabled = busy || s?.state !== "up";
    // A disabled button says why on hover, and Import stands out until there is a relay to use.
    const noRelay = !!s && !s.imported;
    on.title = !s?.installed && s ? "Install WireGuard first" : noRelay ? "Import a relay config first" : "Send game traffic through the relay";
    off.title = "Send game traffic straight to the game server";
    test.title = s?.state === "up" ? "Ping the relay through the tunnel" : "Turn the relay on to test it";
    fileBtn.classList.toggle("ghost", !noRelay);
    const lines: string[] = [];
    // The relay's address stays out of the panel, which gets screenshotted. Hovering the state shows it.
    stateEl.title = s?.endpoint ? `Relay ${s.name ?? ""} at ${s.endpoint}` : "";
    if (s && s.saved > 1) lines.push(`${s.saved} relays saved, Auto tries each`);
    if (s?.state === "up" && s.handshake_age_s != null) lines.push(handshakeText(s.handshake_age_s));
    else if (s?.state === "up" && s.probe_ms != null) lines.push(`relay answering in ${Math.round(s.probe_ms)} ms`);
    else if (s?.state === "up" && !s.detail) lines.push(handshakeText(null));
    if (latency && s?.state === "up") lines.push(latency);
    if (s && !s.imported) lines.push("Paste the relay invite you were sent and press Join, or import its .conf file.");
    if (s?.detail) lines.push(s.detail);
    if (warning) lines.unshift(warning);
    info.textContent = lines.join(" · ");
    renderAuto();
    renderFlow();
  };

  /**
   * The section read top down as one live story: what the app is doing, the game it watches, the
   * path game traffic takes, what was measured and what was decided. Every line is current state.
   */
  function renderFlow(): void {
    const s = status;
    const game = opts.game?.current() ?? DEFAULT_GAME;
    const label = gameLabel(game);
    const running = (opts.game?.running() ?? []).some((n) => isGameProcess(n, game));
    const server = opts.gameTarget?.() ?? null;
    const when = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const now = busy ? `${doing}…` : auto ? (result ? "Watching. Checks the picked path every minute, never switches in a game." : "Waiting for Find best path.") : s?.state === "up" && s.name ? `Holding ${s.name} until you turn it off.` : "Holding direct until you turn a relay on.";
    // League's client phase covers ready check and champ select, before the game process starts.
    const live = running || s?.game_state === "in a game";
    const playing = live ? (server ? `in a match on ${server}` : "in a match") : s?.game_state ?? s?.client_phase ?? "not running";
    const path = !s ? "…" : s.state === "up" && s.name ? `Relay ${s.name}` : s.state === "down" ? "Direct, no relay" : `${STATE_TEXT[s.state]}${s.name ? ` · ${s.name}` : ""}`;
    const med = (p: PathResult) => (p.score?.median != null ? `${p.candidate.label} ${Math.round(p.score.median)} ms` : `${p.candidate.label} –`);
    const measured = result ? `${result.paths.map(med).join(" · ")} median, ${when(result.finished_at)}` : "Nothing yet";
    let decided = auto ? "Nothing yet" : "Manual mode: Auto decides nothing";
    if (result) {
      const gain = result.pick.gain_ms != null ? ` (${Math.abs(Math.round(result.pick.gain_ms))} ms ${result.pick.gain_ms >= 0 ? "better" : "worse"})` : "";
      decided = result.pick.id === "direct" ? `Stay direct${result.pick.vs ? `: ${result.pick.vs} did not win by ${result.min_gain_ms} ms` : ""}` : `Use ${result.pick.id}${gain}`;
      if (!result.applied) decided += ". Not applied yet";
    }
    const rows: [string, string, boolean][] = [
      ["Now", now, busy],
      ["Game", `${label}: ${playing}`, live || !!s?.game_state],
      ["Path", path, s?.state === "up"],
      ["Measured", measured, false],
      ["Decided", decided, false],
    ];
    flowEl.innerHTML = rows.map(([k, v, hot], i) => `<li${hot ? ' class="hot"' : ""}><span class="n">${i + 1}</span><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></li>`).join("");
  }

  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

  function renderAuto(): void {
    manualBtn.setAttribute("aria-pressed", String(!auto));
    autoBtn.setAttribute("aria-pressed", String(auto));
    autoBox.hidden = !auto;
    const league = /^league of legend/i.test(opts.game?.current() ?? DEFAULT_GAME);
    modeHint.textContent = auto
      ? league
        ? "Auto picks on League's own in-game ping from your finished matches, then uses the fastest. It never switches during a match."
        : "Auto measures direct and each relay to the game server, then uses the fastest. It never switches during a match."
      : "Manual: you choose. On sends game traffic through the relay, Off sends it straight to the game server.";
    runBtn.textContent = result ? "Measure again" : "Find best path";
    // Auto owns the tunnel: the manual On/Off only shows in Manual, so there is one control in charge.
    tunnelSeg.hidden = auto;
    runBtn.disabled = busy || !status || (status.imported && !status.installed);
    if (!auto) return;
    if (!result) {
      hostsEl.hidden = true;
      pathsEl.innerHTML = league
        ? `<li class="empty">Not measured yet. Find best path compares League's in-game ping on direct and on each relay over your last matches. ${status?.imported ? "Switches the tunnel only to apply a pick." : "Import a relay config to compare a relay path."}</li>`
        : `<li class="empty">Not measured yet. Find best path measures direct and each relay to the game server, then uses the fastest. ${status?.imported ? "Switches the tunnel once or twice per relay." : "Import a relay config to compare a relay path."}</li>`;
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
    const compared = result.paths.filter((p) => p.score?.eligible && p.score.score != null).length > 1;
    const notes = [result.pick.reason];
    // How the pick is made only matters when there was a comparison to make.
    if (result.pick.matches) notes.push("League's in-game ping decides. The hosts above sit in other cities, so they are pinged from the path in use and shown only.", `Switches only to apply a gain of ${result.min_gain_ms} ms or more.`);
    else if (compared) notes.push(result.pick.live ? "The game server decides alone." : "Without a game server, a relay must win on most hosts.", `Lower score is better. Switches only for a gain of ${result.min_gain_ms} ms or more.`);
    notes.push(result.switches ? `${result.switches} tunnel switch${result.switches === 1 ? "" : "es"}, ${when}.` : `Measured ${when}, tunnel not switched.`);
    if (!result.applied) notes.push("The tunnel is not on the picked path.");
    if (result.error && !result.paths.some((p) => p.note?.includes(result!.error!))) notes.push(result.error);
    // A full run can't switch mid-match, so it is only suggested once the match is over.
    if (recheck) notes.push(opts.gameTarget?.() ? "Run Find best path again after the match." : `Re-check suggested: ${recheck}`);
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
      opts.onStatus?.(status);
    } catch (e) {
      showErr(e);
    }
    render();
  };

  /** What the running action is, for the Now line. */
  let doing = "";
  const run = async (f: () => Promise<void>, what = "Working") => {
    doing = what;
    busy = true;
    warning = "";
    showErr(null);
    render();
    try {
      await f();
    } catch (e) {
      showErr(e);
    }
    busy = false;
    doing = "";
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
      opts.onRelaysChanged?.();
    }, "Importing the relay config");
  });

  inviteIn.addEventListener("input", () => (joinBtn.disabled = busy || !inviteIn.value.trim().startsWith("rigrelay1.")));
  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const invite = inviteIn.value.trim();
    if (!invite) return;
    void run(async () => {
      await api.call<RelaySummary>("relay_join", { invite });
      inviteIn.value = "";
      joinBtn.disabled = true;
      latency = "";
      opts.onRelaysChanged?.();
    }, "Joining the relay");
  });

  on.addEventListener("click", () =>
    void run(async () => {
      latency = "";
      upFailed = true;
      status = await api.call<RelayStatus>("relay_up");
      warning = status.warning ?? "";
      upFailed = false;
    }, "Turning the relay on"),
  );

  off.addEventListener("click", () =>
    void run(async () => {
      latency = "";
      status = await api.call<RelayStatus>("relay_down");
      upFailed = false;
    }, "Turning the relay off"),
  );

  test.addEventListener("click", () =>
    void run(async () => {
      const p = await api.call<PingStats>("relay_ping", { count: 10 });
      latency = p.avg == null ? `relay ${p.host} did not answer` : `relay ${Math.round(p.avg)} ms, ${p.sent - p.received}/${p.sent} lost`;
    }, "Pinging the relay"),
  );

  const setMode = (a: boolean) => {
    const start = a && !auto && !result;
    auto = a;
    store.set("relay.mode", a ? "auto" : "manual");
    render();
    // Picking Auto is the ask to measure: the first run starts now instead of waiting for a
    // second click. Opening the app in Auto mode doesn't start one, so a run (and any admin
    // prompt it brings) only follows a click.
    if (start && !runBtn.disabled) runBtn.click();
  };
  manualBtn.addEventListener("click", () => setMode(false));
  autoBtn.addEventListener("click", () => setMode(true));

  api.on<AutoProgress>("auto:progress", (p) => {
    if (!busy) return;
    prog.textContent = `${p.phase === "direct" ? "Direct" : p.phase} ${p.done}/${p.total}`;
    doing = `Measuring ${p.phase === "direct" ? "direct" : p.phase}: ${p.done} of ${p.total} pings`;
    renderFlow();
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
    }, "Finding the best path"),
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

  /** Connect from the Relays list: a click on one relay is a manual pick, so Auto steps aside. */
  const connect = (name: string) => {
    if (auto) setMode(false);
    return run(async () => {
      latency = "";
      upFailed = true;
      status = await api.call<RelayStatus>("relay_connect", { name });
      warning = status.warning ?? "";
      upFailed = false;
    }, `Connecting to ${name}`);
  };
  const disconnect = () => {
    if (auto) setMode(false);
    void run(async () => {
      latency = "";
      status = await api.call<RelayStatus>("relay_down");
      upFailed = false;
    }, "Turning the relay off");
  };

  fillGames();
  void refresh();
  setInterval(() => {
    if (!busy) void refresh();
  }, 5000);
  setInterval(() => void check(), CHECK_EVERY_MS);
  const matchEl = $("match");
  /** League's own ping for the last match, shown under the relay status. */
  const setMatch = (m: MatchPing | null) => {
    matchEl.hidden = !m;
    if (!m) return;
    const via = m.path === "direct" ? "direct" : m.path === "unknown" ? "path unknown" : `via ${m.path}`;
    const loss = m.loss > 0 ? `${(m.loss * 100).toFixed(1)}% loss` : "no loss";
    matchEl.textContent = `Last match, ${via}: ${Math.round(m.median_ms)} ms in game (p95 ${Math.round(m.p95_ms)}), ${loss}.`;
  };
  return { refresh, connect, disconnect, busy: () => busy, fillGames, setMatch };
}
