import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const PORT = 1420;

// Tauri adds the CSP from tauri.conf.json only to pages it serves from the bundled
// assets. In `tauri dev` the window loads this dev server instead, so without this
// header the dev app runs with no CSP at all (eval included). Reuse the same policy
// and only open the HMR websocket on top of it.
function devCsp(): string {
  const conf = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const csp: Record<string, string> = { ...conf.app.security.csp };
  csp["connect-src"] = `${csp["connect-src"]} ws://127.0.0.1:${PORT} ws://localhost:${PORT}`;
  return Object.entries(csp)
    .map(([k, v]) => `${k} ${v}`)
    .join("; ");
}

// Tauri expects a fixed port and no screen clearing so cargo output stays visible.
const csp = devCsp();
export default defineConfig({
  clearScreen: false,
  server: { port: PORT, strictPort: true, host: "127.0.0.1", headers: { "Content-Security-Policy": csp } },
  preview: { headers: { "Content-Security-Policy": csp } },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2022", sourcemap: true },
});
