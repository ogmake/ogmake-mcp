import { describe, expect, it } from "vitest";
import { realpathSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, isEntrypoint, main } from "./index";

describe("re-exports", () => {
  it("re-exports buildServer from ./server", () => {
    expect(typeof buildServer).toBe("function");
  });
});

describe("main", () => {
  it("builds a server and connects it to the given transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await Promise.all([client.connect(clientTransport), main(serverTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("list_templates");

    await client.close();
  });
});

describe("isEntrypoint", () => {
  it("is false when argv1 is undefined (imported, not run as a script)", () => {
    expect(isEntrypoint(undefined, import.meta.url)).toBe(false);
  });

  it("is false when argv1 doesn't resolve to this module's real path", () => {
    expect(isEntrypoint("/definitely/not/this/file.js", import.meta.url)).toBe(false);
  });

  it("is false (not thrown) when argv1 doesn't exist on disk at all", () => {
    expect(isEntrypoint("/nonexistent/path/nope.js", import.meta.url)).toBe(false);
  });

  it("is true when argv1 IS this file's real path (the direct, non-symlink case)", () => {
    const thisFile = new URL(import.meta.url).pathname;
    expect(isEntrypoint(thisFile, import.meta.url)).toBe(true);
  });

  it("is true through a symlink — the npx/npm-installed bin shape this fix exists for", () => {
    const thisFile = new URL(import.meta.url).pathname;
    const dir = mkdtempSync(join(tmpdir(), "ogmake-mcp-entrypoint-test-"));
    const link = join(dir, "bin-symlink.js");
    symlinkSync(thisFile, link);
    expect(realpathSync(link)).toBe(realpathSync(thisFile));
    expect(isEntrypoint(link, import.meta.url)).toBe(true);
  });

  it("returns false rather than throwing on a malformed importMetaUrl", () => {
    expect(isEntrypoint("/tmp/whatever.js", "not a url")).toBe(false);
  });

  it("is true for a path containing spaces (fileURLToPath decodes %20, .pathname would not)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ogmake-mcp-entrypoint-test-"));
    const spacedDir = join(dir, "has spaces");
    mkdirSync(spacedDir);
    const file = join(spacedDir, "entry file.js");
    writeFileSync(file, "// test file\n");
    const url = pathToFileURL(file).toString();
    expect(url).toContain("%20");
    expect(isEntrypoint(file, url)).toBe(true);
  });
});
