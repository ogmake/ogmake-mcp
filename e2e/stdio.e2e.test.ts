// packages/mcp/e2e/stdio.e2e.test.ts — spawns the PACKED ogmake-mcp tarball
// as a real subprocess (`npx --yes file:<tarball>`, exactly the install
// shape documented in README.md and proven in spike-mcp/RESULTS.md #3) and
// talks real MCP-over-stdio JSON-RPC to it via `StdioClientTransport`,
// against a real local instance of apps/api — the api's Node server
// (apps/api/src/node/server.ts, D130 Cloudflare -> Hetzner) on its own
// throwaway SQLite file — no fakes, no InMemoryTransport, the actual
// end-to-end path a real user's Claude Code/Cursor install would run.
//
// NOT part of `pnpm test`/turbo's `test` task or its 100% coverage gate —
// this is a slow, process-spawning suite. Run explicitly:
//   pnpm --filter ogmake-mcp run test:e2e
//
// Coordination (Opus review of cea5742, replacing the shared mkdir-lock
// design in the now-deleted e2e/lock.ts): NO shared lock, NO fixed port and
// NO shared database. Each run picks its own OS-assigned ephemeral port
// (process-utils.ts's `getFreePort`, retried once on EADDRINUSE), migrates
// its own SQLite file in a fresh temp dir, and spawns the server detached in
// its own process group, tracked ONLY as this process's own in-memory
// variable — nothing written to disk for another run (or a killed run's
// leftover state) to misinterpret. Cleanup happens in `afterAll` and in
// `process.on("exit"|"SIGINT"|"SIGTERM")` handlers below, so a kill of this
// vitest process itself (e.g. scripts/gate.sh's own process-group trap) still
// reaches and kills our server child, whatever is running it. Two copies of
// this suite can run fully concurrently: distinct ports, distinct database
// files, nothing each could stomp on the other's.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getFreePort, killProcessGroup, portOwnedByGroup } from "./process-utils";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MCP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const API_DIR = join(REPO_ROOT, "apps/api");

// Fixed, obviously-fake secrets (the api test lane's TEST_VARS,
// apps/api/src/test/cf-test.ts) shared by the server below and mintKey's
// create-key run, so a key minted here verifies against that server.
const SERVER_SECRETS = {
  BETTER_AUTH_SECRET: "test-only-fake-secret-test-only-fake-secret",
  KEY_HASH_PEPPER: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  SIGNING_KEK: "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=",
};
// Kept a little under beforeAll's own 180_000ms hook timeout (below) so this
// fires and lets us kill anything we've spawned so far *before* vitest's own
// timeout tears the hook down — guards the "late beforeAll-timeout spawn"
// case: without this, a server spawned right as (or just after) the
// hook times out can be assigned to `serverProcess` AFTER `afterAll` has
// already run (having found it `undefined`), leaking the process forever.
const BEFORE_ALL_GUARD_MS = 170_000;

/** Standard base64 (tooling/src/create-key.ts's output format) -> base64url
 * (what OGMAKE_SIGNING_SECRET/env.ts expects). */
function toBase64Url(std: string): string {
  return std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface MintedKey {
  keyId: string;
  apiKey: string;
  signingSecretB64Url: string;
}

/** Mints a real, authenticated API key + signing secret on this run's own
 * SQLite file (the one this suite's server serves) via
 * `tooling/src/create-key.cli.ts` — the same path an operator uses for a
 * real beta invite, run locally rather than against production. */
function mintKey(email: string, dbPath: string): MintedKey {
  const stdout = execFileSync(
    "pnpm",
    [
      "--filter",
      "@ogmake/tooling",
      "run",
      "create-key",
      "--email",
      email,
      "--plan",
      "beta",
      "--quota",
      "5000",
      "--label",
      "ogmake-mcp-e2e",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...SERVER_SECRETS, OGMAKE_DB: dbPath },
    },
  );
  const keyId = /^key id:\s+(\S+)$/m.exec(stdout)?.[1];
  const apiKey = /^API key:\s+(\S+)$/m.exec(stdout)?.[1];
  const signingSecretStdB64 = /^Signing secret:\s+(\S+)$/m.exec(stdout)?.[1];
  if (!keyId || !apiKey || !signingSecretStdB64) {
    throw new Error(`create-key output didn't match the expected shape:\n${stdout}`);
  }
  return { keyId, apiKey, signingSecretB64Url: toBase64Url(signingSecretStdB64) };
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

let serverProcess: ChildProcessWithoutNullStreams | undefined;
let stateDir: string | undefined;
let tarballPath: string;
let tmpNpxCacheDir: string;
let mintedKey: MintedKey;
let hookAborted = false;
// Assigned once beforeAll picks our own ephemeral port; every `it` below
// runs strictly after beforeAll resolves, so this is set by the time any
// test reads it.
let BASE_URL: string;

/** Kills `serverProcess` (if any) by its process group, matching
 * scripts/gate.sh's own convention for the servers it starts. Shared by the
 * beforeAll guard, afterAll and the process-level handlers below so all four
 * tear it down the same way. In-memory only — no pidfile, nothing another
 * run could read. */
function killServer(): void {
  if (serverProcess?.pid) {
    killProcessGroup(serverProcess.pid);
  }
}

// This suite's own cleanup, independent of vitest's afterAll: if the vitest
// worker process running this suite is itself killed (e.g. scripts/gate.sh's
// own process-group SIGTERM, or an interactive Ctrl-C) before afterAll gets
// to run, these still fire and kill our server child so it never
// outlives us. Exit codes match the SIGINT/SIGTERM convention scripts/gate.sh
// itself uses (130/143) so a caller inspecting this process's own exit code
// sees the same story either way.
process.on("exit", killServer);
process.on("SIGINT", () => {
  killServer();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killServer();
  process.exit(143);
});

/** Spawns the api's Node server on a fresh ephemeral port against
 * `dbPath`, detached in its own process group. Retried once on EADDRINUSE —
 * `getFreePort()` closes its probe socket before handing the port over, so
 * something else can in principle win the race and bind it first between
 * our close() and the server's own listen(). No OGMAKE_TRUSTED_PROXIES: the
 * default (the VPS's proxy network) does not include loopback, so the
 * server sees every caller here as its socket address, 127.0.0.1. */
async function spawnServerOnFreePort(dbPath: string, dataDir: string): Promise<{
  port: number;
  proc: ChildProcessWithoutNullStreams;
}> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const port = await getFreePort();
    const proc = spawn("node", ["--import", "tsx", "src/node/server.ts"], {
      cwd: API_DIR,
      stdio: "pipe",
      // detached: own process group, matching scripts/gate.sh's own pattern
      // for astro preview, so killServer() reaches everything it started.
      detached: true,
      env: {
        ...process.env,
        ...SERVER_SECRETS,
        OGMAKE_HOST: "127.0.0.1",
        OGMAKE_PORT: String(port),
        OGMAKE_CRON: "0",
        OGMAKE_DB: dbPath,
        OGMAKE_DATA: dataDir,
        EMAIL_MODE: "sink",
        RENDER_ENGINE: "stub",
        ALLOW_STUB_RENDER: "1",
      },
    });

    // EADDRINUSE surfaces on stderr (the server's own listen error) rather
    // than as a `proc.on("error", ...)` — the node process itself spawns
    // fine; it's its own bind that fails, inside that process.
    // Give it a short window to fail fast before assuming the bind is fine
    // and moving on to the slower HTTP-readiness poll below.
    const addrInUse = await new Promise<boolean>((resolve) => {
      let detected = false;
      const onStderr = (chunk: Buffer) => {
        if (/EADDRINUSE/.test(chunk.toString("utf8"))) {
          detected = true;
          resolve(true);
        }
      };
      const onExit = () => {
        if (!detected) resolve(false);
      };
      proc.stderr.on("data", onStderr);
      proc.once("exit", onExit);
      setTimeout(() => {
        proc.stderr.off("data", onStderr);
        proc.off("exit", onExit);
        resolve(detected);
      }, 3_000);
    });

    if (addrInUse) {
      if (proc.pid) killProcessGroup(proc.pid);
      if (attempt === 2) {
        throw new Error(`the api server hit EADDRINUSE on a freshly-picked ephemeral port twice in a row`);
      }
      continue;
    }
    return { port, proc };
  }
  throw new Error("unreachable");
}

beforeAll(async () => {
  // Guards the "late beforeAll-timeout spawn" case: vitest's own hook
  // timeout can fire (rejecting this beforeAll, so vitest moves straight to
  // afterAll — which finds `serverProcess` still undefined) WHILE the async
  // work below is still mid-flight and about to assign it. This timer sets
  // `hookAborted` a little before that happens; every await point below
  // checks it and kills anything already spawned itself rather than leaving
  // it for an afterAll that already ran and saw nothing to clean up.
  const abortGuard = setTimeout(() => {
    hookAborted = true;
  }, BEFORE_ALL_GUARD_MS);

  try {
    if (hookAborted) throw new Error("beforeAll aborted (approaching hook timeout) before the server spawn");

    // Build the web app (the server serves it), then migrate this run's own
    // SQLite file, then start the server — chained so the build/migration
    // always finish before the server binds its port. Stub render engine: no
    // Chromium attached locally.
    await run("pnpm", ["--filter", "@ogmake/web", "run", "build"], REPO_ROOT);
    if (hookAborted) throw new Error("beforeAll aborted (approaching hook timeout) before the server spawn");
    stateDir = mkdtempSync(join(tmpdir(), "ogmake-mcp-e2e-state-"));
    const dbPath = join(stateDir, "ogmake.sqlite");
    await run("node", [join(API_DIR, "scripts/migrate.mjs"), dbPath], REPO_ROOT);
    if (hookAborted) throw new Error("beforeAll aborted (approaching hook timeout) before the server spawn");

    const { port, proc } = await spawnServerOnFreePort(dbPath, join(stateDir, "data"));
    serverProcess = proc;
    BASE_URL = `http://127.0.0.1:${port}`;
    if (hookAborted) {
      killServer();
      throw new Error("beforeAll aborted (approaching hook timeout) right after the server spawn");
    }

    let ready = false;
    serverProcess.stdout.on("data", () => {});
    serverProcess.stderr.on("data", () => {});

    const deadline = Date.now() + 60_000;
    while (!ready && !hookAborted && Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE_URL}/v1/templates`);
        // Readiness alone isn't enough to prove it's OUR server (something
        // else could in principle have won the ephemeral port — see
        // spawnServerOnFreePort's own EADDRINUSE retry) — verify by pid
        // match: every pid LISTENing on `port` must belong to our own spawned
        // process group.
        if ((res.ok || res.status === 404) && serverProcess.pid && portOwnedByGroup(port, serverProcess.pid)) {
          ready = true;
        }
      } catch {
        // not up yet
      }
      if (!ready) await new Promise((r) => setTimeout(r, 500));
    }
    if (hookAborted) {
      killServer();
      throw new Error("beforeAll aborted (approaching hook timeout) while waiting for the server");
    }
    if (!ready) {
      killServer();
      throw new Error("the api server did not become ready (and pid-verified as ours) within 60s");
    }

    // Mint a real, authenticated key on this run's own database — used by
    // both the authenticated render_image test and the signed
    // build_image_url test below.
    mintedKey = mintKey(`ogmake-mcp-e2e-${randomBytes(6).toString("hex")}@example.com`, dbPath);
    if (hookAborted) {
      killServer();
      throw new Error("beforeAll aborted (approaching hook timeout) after minting the e2e key");
    }

    // Pack the CLI (build + npm pack), matching exactly what a real install
    // does — never reuse a stale dist/tarball from an earlier, possibly
    // stale, `pnpm run build`.
    await run("pnpm", ["run", "pack"], MCP_ROOT);
    // Derived from package.json's own version (not a second hardcoded
    // "0.1.0" literal that can silently drift from it — a bump there would
    // otherwise leave this pointing at a tarball `npm pack` no longer wrote).
    const mcpPkg = JSON.parse(readFileSync(join(MCP_ROOT, "package.json"), "utf8")) as { version: string };
    tarballPath = join(MCP_ROOT, "pack-out", `ogmake-mcp-${mcpPkg.version}.tgz`);

    // A fresh npx cache dir per run: `npx --yes file:<tgz>` caches the
    // extracted install keyed by tarball content — reusing the default
    // global npx cache across repeated e2e runs of a same-named,
    // same-version-but-different-content tarball has caused stale-install
    // false negatives before (npm's own known npx-cache-key sharp edge with
    // local `file:` specs); an isolated cache removes that variable.
    tmpNpxCacheDir = mkdtempSync(join(tmpdir(), "ogmake-mcp-npx-cache-"));
    if (hookAborted) {
      killServer();
      throw new Error("beforeAll aborted (approaching hook timeout) after packing the tarball");
    }
  } finally {
    clearTimeout(abortGuard);
  }
}, 180_000);

afterAll(async () => {
  killServer();
  if (serverProcess?.pid) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (stateDir) {
    rmSync(stateDir, { recursive: true, force: true });
  }
  if (tmpNpxCacheDir) {
    rmSync(tmpNpxCacheDir, { recursive: true, force: true });
  }
}, 30_000);

describe("ogmake-mcp packed tarball, real stdio, real local API", () => {
  it("list_templates: real tool round-trip against a local api server", async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["--yes", `file:${tarballPath}`],
      env: {
        ...(process.env as Record<string, string>),
        OGMAKE_BASE_URL: BASE_URL,
        npm_config_cache: tmpNpxCacheDir,
      },
    });
    const client = new Client({ name: "e2e-client", version: "0.0.1" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "auto_image_url",
        "build_image_url",
        "check_link_preview",
        "create_batch",
        "get_batch",
        "get_usage",
        "list_templates",
        "og_snippet",
        "render_html",
        "render_image",
      ]);

      const result = await client.callTool({ name: "list_templates", arguments: {} });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      const parsed = JSON.parse(content[0]?.text ?? "{}") as { templates?: unknown[] };
      expect(Array.isArray(parsed.templates)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("render_image (free/no-key mode): real image bytes back over stdio", async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["--yes", `file:${tarballPath}`],
      env: {
        ...(process.env as Record<string, string>),
        OGMAKE_BASE_URL: BASE_URL,
        npm_config_cache: tmpNpxCacheDir,
      },
    });
    const client = new Client({ name: "e2e-client", version: "0.0.1" });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "render_image",
        arguments: { title: "ogmake-mcp e2e" },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; data?: string; mimeType?: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("image");
      expect(typeof content[0]?.data).toBe("string");
      expect((content[0]?.data ?? "").length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("render_image (authenticated, real API key): real render via the authenticated path", async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["--yes", `file:${tarballPath}`],
      env: {
        ...(process.env as Record<string, string>),
        OGMAKE_BASE_URL: BASE_URL,
        OGMAKE_API_KEY: mintedKey.apiKey,
        npm_config_cache: tmpNpxCacheDir,
      },
    });
    const client = new Client({ name: "e2e-client", version: "0.0.1" });
    await client.connect(transport);
    try {
      const templates = await client.callTool({ name: "list_templates", arguments: {} });
      const templatesContent = templates.content as Array<{ type: string; text?: string }>;
      const parsedTemplates = JSON.parse(templatesContent[0]?.text ?? "{}") as {
        templates?: Array<{ id: string }>;
      };
      const templateId = parsedTemplates.templates?.[0]?.id;
      expect(templateId).toBeTruthy();

      const result = await client.callTool({
        name: "render_image",
        arguments: { template: templateId, params: { title: "ogmake-mcp e2e" } },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text?: string; data?: string }>;
      // First block is the text summary (rendered.url + metadata, per
      // server.ts's render_image handler) — an authenticated render, unlike
      // free/no-key mode's image-only reply.
      expect(content[0]?.type).toBe("text");
      // The inline image-bytes block is best-effort (server.ts's own
      // handler comment): `rendered.url` is the real hosted asset domain
      // (production ogmake.com), not this suite's local api server, so
      // fetching it back for a preview is expected to fail/no-op here —
      // the authenticated render call itself succeeding is what this test
      // proves.
      const rendered = JSON.parse(content[0]?.text ?? "{}") as { url?: string };
      expect(typeof rendered.url).toBe("string");
      expect(rendered.url).toMatch(/^https?:\/\//);
    } finally {
      await client.close();
    }
  });

  it("build_image_url (signed) -> GET the /i URL: real 200 image response", async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["--yes", `file:${tarballPath}`],
      env: {
        ...(process.env as Record<string, string>),
        OGMAKE_BASE_URL: BASE_URL,
        OGMAKE_SIGNING_SECRET: mintedKey.signingSecretB64Url,
        OGMAKE_SIGNING_KEY_ID: mintedKey.keyId,
        npm_config_cache: tmpNpxCacheDir,
      },
    });
    const client = new Client({ name: "e2e-client", version: "0.0.1" });
    await client.connect(transport);
    let signedUrl: string;
    try {
      const templates = await client.callTool({ name: "list_templates", arguments: {} });
      const templatesContent = templates.content as Array<{ type: string; text?: string }>;
      const parsedTemplates = JSON.parse(templatesContent[0]?.text ?? "{}") as {
        templates?: Array<{ id: string }>;
      };
      const templateId = parsedTemplates.templates?.[0]?.id;
      expect(templateId).toBeTruthy();

      const result = await client.callTool({
        name: "build_image_url",
        arguments: { template: templateId },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      signedUrl = content[0]?.text ?? "";
      expect(signedUrl).toContain(`/i/${mintedKey.keyId}/`);
    } finally {
      await client.close();
    }

    const response = await fetch(signedUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toMatch(/^image\//);
    await response.arrayBuffer();
  });

  // Matrix gap 2 (2026-09-22): get_usage and og_snippet were listed in the
  // "registers exactly the five specced tools" round-trip above but never
  // actually CALLED here — this closes that gap with real calls over real
  // stdio against the real local api server.
  it("get_usage: real numbers match a direct GET /v1/usage call with the same key", async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["--yes", `file:${tarballPath}`],
      env: {
        ...(process.env as Record<string, string>),
        OGMAKE_BASE_URL: BASE_URL,
        OGMAKE_API_KEY: mintedKey.apiKey,
        npm_config_cache: tmpNpxCacheDir,
      },
    });
    const client = new Client({ name: "e2e-client", version: "0.0.1" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "get_usage", arguments: {} });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      const usage = JSON.parse(content[0]?.text ?? "{}") as {
        plan?: string;
        period?: string;
        credits?: number;
        cap?: number;
      };

      const directRes = await fetch(`${BASE_URL}/v1/usage`, {
        headers: { Authorization: `Bearer ${mintedKey.apiKey}` },
      });
      expect(directRes.status).toBe(200);
      const direct = (await directRes.json()) as {
        plan?: string;
        period?: string;
        credits?: number;
        cap?: number;
      };

      expect(usage.plan).toBe(direct.plan);
      expect(usage.period).toBe(direct.period);
      expect(usage.credits).toBe(direct.credits);
      expect(usage.cap).toBe(direct.cap);
    } finally {
      await client.close();
    }
  });

  it("og_snippet: real snippet contains a correctly signed URL from build_image_url", async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["--yes", `file:${tarballPath}`],
      env: {
        ...(process.env as Record<string, string>),
        OGMAKE_BASE_URL: BASE_URL,
        OGMAKE_SIGNING_SECRET: mintedKey.signingSecretB64Url,
        OGMAKE_SIGNING_KEY_ID: mintedKey.keyId,
        npm_config_cache: tmpNpxCacheDir,
      },
    });
    const client = new Client({ name: "e2e-client", version: "0.0.1" });
    await client.connect(transport);
    try {
      const templates = await client.callTool({ name: "list_templates", arguments: {} });
      const templatesContent = templates.content as Array<{ type: string; text?: string }>;
      const parsedTemplates = JSON.parse(templatesContent[0]?.text ?? "{}") as {
        templates?: Array<{ id: string }>;
      };
      const templateId = parsedTemplates.templates?.[0]?.id;
      expect(templateId).toBeTruthy();

      const built = await client.callTool({ name: "build_image_url", arguments: { template: templateId } });
      const builtContent = built.content as Array<{ type: string; text?: string }>;
      const signedUrl = builtContent[0]?.text ?? "";
      expect(signedUrl).toContain(`/i/${mintedKey.keyId}/`);

      const snippet = await client.callTool({
        name: "og_snippet",
        arguments: { framework: "html", imageUrl: signedUrl },
      });
      expect(snippet.isError).not.toBe(true);
      const snippetContent = snippet.content as Array<{ type: string; text?: string }>;
      const snippetText = snippetContent[0]?.text ?? "";
      expect(snippetText).toContain(signedUrl);
      expect(snippetText).toContain("og:image");

      // Prove the URL embedded in the snippet is the actual, correctly
      // signed one (not just any string) by GETting it: a real 200 image.
      const response = await fetch(signedUrl);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toMatch(/^image\//);
      await response.arrayBuffer();
    } finally {
      await client.close();
    }
  });
});
