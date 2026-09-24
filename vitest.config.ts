import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // node by default; a React component test opts into jsdom with a
    // `// @vitest-environment jsdom` line at its top (ADR-014).
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
