#!/usr/bin/env node
// packages/mcp/src/index.ts — ogmake-mcp entrypoint (local stdio only).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildServer } from "./server";

export { buildServer } from "./server";

/** True when this module is being run as the process entrypoint (`node
 * index.js`, or via an npm/npx-installed `bin` symlink) rather than merely
 * imported (tests, `export { buildServer }` consumers). Comparing
 * `import.meta.url` to `file://${argv1}` directly is broken for an
 * npm/npx-installed bin — the bin entry is a symlink, so `argv[1]` is the
 * symlink path while `import.meta.url` resolves the target differently;
 * the naive comparison silently fails, `main()` never runs, and the
 * process exits 0 with zero output (looks like a hang, is actually a
 * no-op) — confirmed broken/fixed in spike-mcp/RESULTS.md #3. Resolving
 * both sides to their real path fixes it. `fileURLToPath` (not
 * `new URL(...).pathname`) is required here: `.pathname` leaves
 * percent-encoding in place (a path containing a space becomes `%20` and
 * never matches `argv1`), and it is not the platform-correct filesystem
 * path on Windows either. Exported as a pure function so it's
 * unit-testable without actually spawning a process (the real
 * spawned-process behavior is covered by this package's e2e stdio suite). */
export function isEntrypoint(argv1: string | undefined, importMetaUrl: string): boolean {
  try {
    return realpathSync(argv1 ?? "") === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

/** `transport` is a DI seam for index.test.ts: the real process entrypoint
 * below always uses the default `StdioServerTransport` (stdin/stdout) —
 * unit tests pass an `InMemoryTransport` half instead, so this connect flow
 * is covered without touching real stdio (which could hang a test runner
 * waiting on stdin). */
export async function main(transport: Transport = new StdioServerTransport()): Promise<void> {
  const server = buildServer();
  await server.connect(transport);
}

/* v8 ignore start -- process bootstrapping: only runs when this file is
 * executed as the actual entrypoint (`node dist/index.js`, or the `npx
 * --yes file:<tarball>`-installed bin). Under vitest this module is only
 * ever imported, never run directly, so `isEntrypoint` is always false
 * here — the true-branch (`main().catch(...)`) is exercised by this
 * package's e2e stdio suite (spawns the packed CLI as a real subprocess),
 * not by unit coverage. `isEntrypoint` itself is unit-tested directly in
 * index.test.ts. */
if (isEntrypoint(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
/* v8 ignore stop */
