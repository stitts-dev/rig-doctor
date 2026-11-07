// Relay tunnel section: import the WireGuard config from rig-relay-add-peer, turn the tunnel
// on and off, and show whether it is handshaking and how fast the relay answers.

import type { Backend } from "./backend";
import type { PingStats } from "./types";

export interface RelaySummary {
  endpoint: string;
  address: string;
  peer_key: string;
  allowed_ips: number;
  probe: string | null;
  keepalive: number | null;
}

export type TunnelState = "down" | "starting" | "up" | "stopping";

export interface RelayStatus {
  installed: boolean;
  imported: boolean;
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

const STATE_TEXT: Record<TunnelState, string> = { down: "Off", starting: "Starting", up: "On", stopping: "Stopping" };

export function mountRelay(api: Backend, root: HTMLElement): { refresh: () => Promise<void> } {
  root.innerHTML = `
    <div class="label"><span>Relay</span><span class="num" data-r="state">Off</span></div>
    <div class="relay-row">
      <label class="btn tiny relay-file">Import config<input type="file" accept=".conf,text/plain" hidden data-r="file" /></label>
      <button class="btn tiny" type="button" data-r="toggle" disabled>Turn on</button>
      <button class="btn tiny" type="button" data-r="test" disabled>Test</button>
    </div>
    <div class="foot" data-r="info"></div>
    <div class="foot relay-err" data-r="err" hidden></div>`;
  const $ = <T extends HTMLElement>(k: string) => root.querySelector<T>(`[data-r="${k}"]`)!;
  const stateEl = $("state");
  const file = $<HTMLInputElement>("file");
  const toggle = $<HTMLButtonElement>("toggle");
  const test = $<HTMLButtonElement>("test");
  const info = $("info");
  const err = $("err");

  let status: RelayStatus | undefined;
  let latency = "";
  let busy = false;

  const showErr = (e: unknown) => {
    err.textContent = e ? String(e) : "";
    err.hidden = !e;
  };

  const render = () => {
    const s = status;
    stateEl.textContent = s ? STATE_TEXT[s.state] : "…";
    stateEl.classList.toggle("relay-on", s?.state === "up");
    const ready = !!s && s.installed && s.imported;
    toggle.disabled = busy || !s || !ready || s.state === "starting" || s.state === "stopping";
    toggle.textContent = s?.state === "up" ? "Turn off" : "Turn on";
    test.disabled = busy || s?.state !== "up";
    const lines: string[] = [];
    if (s?.endpoint) lines.push(`Relay ${s.endpoint}`);
    if (s?.state === "up" && s.handshake_age_s != null) lines.push(handshakeText(s.handshake_age_s));
    else if (s?.state === "up" && s.probe_ms != null) lines.push(`relay answering in ${Math.round(s.probe_ms)} ms`);
    else if (s?.state === "up" && !s.detail) lines.push(handshakeText(null));
    if (latency && s?.state === "up") lines.push(latency);
    if (s && !s.imported) lines.push("Import the .conf from rig-relay-add-peer.");
    if (s?.detail) lines.push(s.detail);
    info.textContent = lines.join(" · ");
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
      await api.call<RelaySummary>("relay_import", { text });
      latency = "";
    });
  });

  toggle.addEventListener("click", () =>
    void run(async () => {
      latency = "";
      status = await api.call<RelayStatus>(status?.state === "up" ? "relay_down" : "relay_up");
    }),
  );

  test.addEventListener("click", () =>
    void run(async () => {
      const p = await api.call<PingStats>("relay_ping", { count: 10 });
      latency = p.avg == null ? `relay ${p.host} did not answer` : `relay ${Math.round(p.avg)} ms, ${p.sent - p.received}/${p.sent} lost`;
    }),
  );

  void refresh();
  setInterval(() => {
    if (!busy) void refresh();
  }, 5000);
  return { refresh };
}
