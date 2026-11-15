import { defineConfig } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const host = process.env.TAURI_DEV_HOST;

// Every build gets its own id, e.g. 20261115-104233. It is shown in the app and
// stamped into the service worker, so each deploy is seen as a new version.
const BUILD = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");

export default defineConfig({
  // GitHub Pages serves the site under /ez-ocr/; Tauri serves it at the root.
  base: process.env.GH_PAGES ? "/ez-ocr/" : "/",
  clearScreen: false,
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [
    {
      name: "stamp-service-worker",
      apply: "build",
      closeBundle() {
        const file = resolve("dist/sw.js");
        writeFileSync(file, readFileSync(file, "utf8").replaceAll("__BUILD__", BUILD));
      },
    },
  ],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
