import { defineConfig } from "vite";

// Tauri expects a fixed port and no screen clearing so cargo output stays visible.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2022", sourcemap: true },
});
