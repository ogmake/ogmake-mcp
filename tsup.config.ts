import { defineConfig } from "tsup";
import path from "node:path";

// packages/mcp — bundles this package's own source AND the two private,
// unpublished workspace packages it depends on (@ogmake/sdk, @ogmake/core)
// into dist/index.js: a private workspace package is unresolvable when a
// consumer's `npx --yes file:<tarball>` runs `npm install` against the
// packed tarball (spike-mcp/RESULTS.md #5) — it must ship as bundled
// source, not as a `dependencies` entry. Only the two real, registry-
// resolvable deps (@modelcontextprotocol/sdk, zod) stay external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node18",
  bundle: true,
  clean: true,
  dts: false,
  sourcemap: false,
  splitting: false,
  shims: false,
  // The sdk and signing helper are vendored under vendor/ in this mirror.
  esbuildOptions(options) {
    options.alias = {
      "@ogmake/sdk": path.resolve("vendor/sdk/index.ts"),
      "@ogmake/core/src/signing": path.resolve("vendor/core/signing.ts"),
    };
  },
  external: ["@modelcontextprotocol/sdk", "zod"],
  // No `banner` here: src/index.ts already starts with its own
  // `#!/usr/bin/env node` shebang line, which tsup preserves verbatim —
  // adding a banner too produced a duplicate shebang line in dist/index.js.
});
