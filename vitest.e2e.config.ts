import { defineConfig } from "vitest/config";

// Separate config (no coverage thresholds — this is a process-spawning e2e
// suite, not unit coverage) so `pnpm test:e2e` never runs as part of
// `pnpm test`/turbo's `test` task. Run explicitly: see e2e/README notes in
// stdio.e2e.test.ts's own header comment.
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
