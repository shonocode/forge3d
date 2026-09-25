import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import viteCompression from "vite-plugin-compression";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pages serves the site under /forge3d/; GitHub Actions sets
  // GITHUB_ACTIONS=true, and the Pages workflow is the only build that runs
  // there. Local builds keep the root.
  base: process.env.GITHUB_ACTIONS === "true" ? "/forge3d/" : "/",
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
  plugins: [react(), VitePWA({
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
  }), viteCompression({ algorithm: "gzip", threshold: 10240 })],
});