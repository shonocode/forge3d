import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import viteCompression from "vite-plugin-compression";

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  server: { host: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@babylonjs/serializers")) return "babylonjs-serializers";
          if (id.includes("@babylonjs/loaders")) return "babylonjs-loaders";
          if (id.includes("@babylonjs/core")) return "babylonjs-core";
        },
      },
    },
  },
  plugins: [VitePWA({
    registerType: "autoUpdate",
    includeAssets: ["favicon.svg"],
    manifest: {
      name: "FORGE 3D",
      short_name: "FORGE3D",
      description: "3D Modeling, Rigging & Animation Tool",
      theme_color: "#08080c",
      background_color: "#08080c",
      display: "standalone",
      orientation: "any",
      icons: [
        { src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      ],
    },
    workbox: {
      globPatterns: ["**/*.{js,css,html,wasm}"],
      maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
    },
  }), viteCompression({ algorithm: "gzip", threshold: 10240 }), cloudflare()],
});