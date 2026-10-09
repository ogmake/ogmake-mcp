// packages/mcp/e2e/process-utils.ts — process/port utilities for the stdio
// e2e suite. Replaces e2e/lock.ts's mkdir-lock design (Opus review of
// cea5742): that lock could have one gate's EXIT trap kill a DIFFERENT,
// concurrent gate's `wrangler dev` and delete its lock (no pid-reuse
// protection, mkdir->write races, and a trap whose own exit code could
// silently become 0). There is no shared lock and no fixed port any more:
// each run picks its own OS-assigned ephemeral port (see `getFreePort`
// below) and tracks only its own in-memory child pid/pgid — nothing is
// written to disk to coordinate between runs, so there is nothing for a
// stale or foreign record to corrupt.
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";

/** Binds an OS-assigned ephemeral port, reads it back, and releases it
 * immediately so the caller's own child process (wrangler dev) can bind it
 * itself. Inherently TOCTOU — something else could in principle grab the
 * port between our close() and the child's bind — so callers retry once on
 * EADDRINUSE rather than trust this alone. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not determine bound ephemeral port"));
        return;
      }
      const port = address.port;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

/** Best-effort kill of a whole process group (negative pid) — used for a
 * detached `wrangler dev` child, whose pgid equals its own pid (see
 * stdio.e2e.test.ts's spawn call). Never throws — the group may already be
 * gone by the time this runs. */
export function killProcessGroup(pgid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // already gone
  }
}

/** pids (if any) currently LISTENing on `port`, via `lsof -t`. Empty array
 * if lsof reports nothing (port free) or isn't installed. */
export function listeningPids(port: number): number[] {
  try {
    const out = execFileSync("lsof", ["-t", "-i", `TCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => Number(line))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/** The process group id of a running pid, via `ps -o pgid=`. `undefined` if
 * the pid is gone or `ps` fails. */
export function processGroupOf(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const pgid = Number(out);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

/** True if `port` is currently owned by process group `ourPgid` — i.e. every
 * pid LISTENing on it belongs to our own spawned `wrangler dev` tree, not
 * some other process that happened to win the same ephemeral port. This is
 * the "is this OUR instance" readiness check (pid-match) once an HTTP probe
 * says something answered on the port. */
export function portOwnedByGroup(port: number, ourPgid: number): boolean {
  const pids = listeningPids(port);
  if (pids.length === 0) return false;
  return pids.every((pid) => processGroupOf(pid) === ourPgid);
}

/** True if nothing is LISTENing on `port` at all. */
export function portIsFree(port: number): boolean {
  return listeningPids(port).length === 0;
}
