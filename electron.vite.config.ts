import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://i.ytimg.com",
  "media-src 'self' blob: mediastream:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  // Le lecteur de « Regarder ensemble » vit sur le serveur de salons, quelle que soit son adresse.
  "frame-src http: https:",
  "worker-src 'self' blob:",
].join("; ");

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve("src/main/index.ts") } } },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: { rollupOptions: { input: { index: resolve("src/renderer/index.html") } } },
    resolve: { alias: { "@shared": resolve("src/shared") } },
    plugins: [
      react(),
      {
        name: "spoka-csp",
        apply: "build",
        transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" }],
      },
    ],
  },
});
