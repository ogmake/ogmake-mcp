import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  OgmakeApiError,
  OgmakeNetworkError,
  OgmakeRedirectError,
  type OgmakeClient,
} from "@ogmake/sdk";
import { buildServer, type BuildServerOptions } from "./server";
import { base64UrlDecode, type OgmakeEnv } from "./env";

const SECRET = "og_live_TOTALLY_SECRET_KEY_VALUE";
const SIGNING_SECRET_B64URL = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");
const SIGNING_SECRET_LITERAL = "SUPER_SECRET_SIGNING_MATERIAL";

function fakeClient(overrides: Partial<OgmakeClient> = {}): OgmakeClient {
  return {
    renderImage: vi.fn(async () => ({
      url: "https://ogmake.com/o/abc.png",
      hash: "abc",
      cached: false,
      width: 1200,
      height: 630,
      format: "png",
      bytes: 100,
      templateVersion: "1",
    })),
    listTemplates: vi.fn(async () => ({ templates: [{ id: "hero", version: "1", params: {} }] })),
    getUsage: vi.fn(async () => ({
      plan: "starter",
      period: "2026-09",
      credits: 1,
      cap: 100,
      hardCap: 120,
      rolledOver: 0,
      remaining: 99,
      overCapSince: null,
    })),
    renderHtml: vi.fn(async () => ({
      url: "https://ogmake.com/o/img/paid/k/html.png",
      hash: "h",
      cached: false as const,
      width: 1200,
      height: 630,
      format: "png",
      bytes: 100,
      credits: 2,
    })),
    freeRender: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" })),
    signImageUrl: vi.fn(async () => "https://ogmake.com/i/key_1/sig123?template=hero"),
    publicImageUrl: vi.fn((keyId: string, templateId: string) => `https://ogmake.com/p/${keyId}/${templateId}`),
    renderImageAsync: vi.fn(async () => ({ request_id: "req_1", status: "processing" as const })),
    createBatch: vi.fn(async () => ({ batch_id: "bat_1", status: "queued" as const, total: 2, status_url: "/v1/batch/bat_1" })),
    createBatchCsv: vi.fn(async () => ({ batch_id: "bat_1", status: "queued" as const, total: 2, status_url: "/v1/batch/bat_1" })),
    getBatch: vi.fn(async () => ({
      batch_id: "bat_1",
      status: "completed" as const,
      total: 1,
      succeeded: 1,
      failed: 0,
      pending: 0,
      created_at: 1,
      completed_at: 2,
      webhook: null,
      items: [{ index: 0, template: "basic", status: "succeeded" as const, url: "https://ogmake.com/o/x.png" }],
    })),
    listWebhookDeliveries: vi.fn(async () => ({ deliveries: [] })),
    ...overrides,
  };
}

async function connectedClient(options: BuildServerOptions) {
  const server = buildServer(options);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function envWith(overrides: Partial<OgmakeEnv> = {}): OgmakeEnv {
  return {
    apiKey: undefined,
    baseUrl: undefined,
    signingSecretB64Url: undefined,
    signingKeyId: undefined,
    publicKeyId: undefined,
    ...overrides,
  };
}

describe("buildServer — tool listing", () => {
  it("registers exactly the nine specced tools", async () => {
    const { client, server } = await connectedClient({ env: envWith(), client: fakeClient() });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "build_image_url",
      "create_batch",
      "get_batch",
      "get_usage",
      "list_templates",
      "og_snippet",
      "render_html",
      "render_image",
    ]);
    await client.close();
    await server.close();
  });
});

describe("list_templates", () => {
  it("returns the templates list as JSON text", async () => {
    const { client, server } = await connectedClient({ env: envWith(), client: fakeClient() });
    const result = await client.callTool({ name: "list_templates", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(JSON.parse(content[0]?.text ?? "")).toEqual({ templates: [{ id: "hero", version: "1", params: {} }] });
    await client.close();
    await server.close();
  });

  it("returns isError:true with a safe message on API failure", async () => {
    const { client, server } = await connectedClient({
      env: envWith(),
      client: fakeClient({
        listTemplates: vi.fn(async () => {
          throw new OgmakeApiError("render_unavailable", 503);
        }),
      }),
    });
    const result = await client.callTool({ name: "list_templates", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("render_unavailable");
    await client.close();
    await server.close();
  });
});

describe("render_image — authenticated mode (OGMAKE_API_KEY set)", () => {
  it("requires `template`", async () => {
    const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: fakeClient() });
    const result = await client.callTool({ name: "render_image", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/`template` is required/);
    await client.close();
    await server.close();
  });

  it("returns metadata text plus an image content block on success", async () => {
    const { client, server } = await connectedClient({
      env: envWith({ apiKey: SECRET }),
      client: fakeClient(),
      fetchImageBytes: vi.fn(async () => ({ data: "QkFTRTY0", mimeType: "image/png" })),
    });
    const result = await client.callTool({
      name: "render_image",
      arguments: { template: "hero", params: { title: "Hi" }, format: "webp", preset: "square", scale: "2", v: "1", bg: "grid" },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[1]?.type).toBe("image");
    expect(content[1]?.mimeType).toBe("image/png");
    await client.close();
    await server.close();
  });

  it("degrades to text-only when the follow-up image fetch fails", async () => {
    const { client, server } = await connectedClient({
      env: envWith({ apiKey: SECRET }),
      client: fakeClient(),
      fetchImageBytes: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const result = await client.callTool({ name: "render_image", arguments: { template: "hero" } });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    await client.close();
    await server.close();
  });

  it("returns isError:true on a quota_exceeded API error", async () => {
    const { client, server } = await connectedClient({
      env: envWith({ apiKey: SECRET }),
      client: fakeClient({
        renderImage: vi.fn(async () => {
          throw new OgmakeApiError("quota_exceeded", 429, [{ field: "cap", message: "over" }]);
        }),
      }),
    });
    const result = await client.callTool({ name: "render_image", arguments: { template: "hero" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("quota_exceeded");
    expect(content[0]?.text).toContain("cap: over");
    await client.close();
    await server.close();
  });

  it("rejects a params object over the key-count cap before any network call", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: client_ });
    const params: Record<string, string> = {};
    for (let i = 0; i < 21; i++) params[`k${i}`] = "v";
    const result = await client.callTool({ name: "render_image", arguments: { template: "hero", params } });
    expect(result.isError).toBe(true);
    expect(client_.renderImage).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });
});

describe("render_image — free mode (no OGMAKE_API_KEY)", () => {
  it("requires `title`", async () => {
    const { client, server } = await connectedClient({ env: envWith(), client: fakeClient() });
    const result = await client.callTool({ name: "render_image", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/`title` is required/);
    await client.close();
    await server.close();
  });

  it("returns image bytes only, no text/url content block", async () => {
    const { client, server } = await connectedClient({ env: envWith(), client: fakeClient() });
    const result = await client.callTool({
      name: "render_image",
      arguments: { title: "Hello", description: "desc", site: "example.com" },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("image");
    await client.close();
    await server.close();
  });

  it("returns isError:true on a network failure", async () => {
    const { client, server } = await connectedClient({
      env: envWith(),
      client: fakeClient({
        freeRender: vi.fn(async () => {
          throw new OgmakeNetworkError(new Error("ECONNRESET"));
        }),
      }),
    });
    const result = await client.callTool({ name: "render_image", arguments: { title: "Hi" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("ECONNRESET");
    await client.close();
    await server.close();
  });

  it("returns isError:true on a redirect refusal", async () => {
    const { client, server } = await connectedClient({
      env: envWith(),
      client: fakeClient({
        freeRender: vi.fn(async () => {
          throw new OgmakeRedirectError(302, "https://evil.example/");
        }),
      }),
    });
    const result = await client.callTool({ name: "render_image", arguments: { title: "Hi" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/redirect/);
    await client.close();
    await server.close();
  });

  it("returns isError:true with a generic message for a plain thrown Error", async () => {
    const { client, server } = await connectedClient({
      env: envWith(),
      client: fakeClient({
        freeRender: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    });
    const result = await client.callTool({ name: "render_image", arguments: { title: "Hi" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe("boom");
    await client.close();
    await server.close();
  });

  it("returns isError:true with a fallback message for a non-Error throw", async () => {
    const { client, server } = await connectedClient({
      env: envWith(),
      client: fakeClient({
        freeRender: vi.fn(async () => {
          throw "not an Error object";
        }),
      }),
    });
    const result = await client.callTool({ name: "render_image", arguments: { title: "Hi" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe("unknown error");
    await client.close();
    await server.close();
  });
});

describe("build_image_url", () => {
  it("signs locally when OGMAKE_SIGNING_SECRET + OGMAKE_SIGNING_KEY_ID are set", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({
      env: envWith({ signingSecretB64Url: SIGNING_SECRET_B64URL, signingKeyId: "key_1" }),
      client: client_,
    });
    const result = await client.callTool({ name: "build_image_url", arguments: { template: "hero" } });
    expect(result.isError).not.toBe(true);
    expect(client_.signImageUrl).toHaveBeenCalledWith("key_1", expect.any(Uint8Array), expect.objectContaining({ template: "hero" }));
    await client.close();
    await server.close();
  });

  it("passes optional params/format/preset/scale/v/bg through to signImageUrl", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({
      env: envWith({ signingSecretB64Url: SIGNING_SECRET_B64URL, signingKeyId: "key_1" }),
      client: client_,
    });
    await client.callTool({
      name: "build_image_url",
      arguments: { template: "hero", params: { title: "Hi" }, format: "png", preset: "og", scale: "1", v: "2", bg: "grid" },
    });
    expect(client_.signImageUrl).toHaveBeenCalledWith(
      "key_1",
      expect.any(Uint8Array),
      { template: "hero", params: { title: "Hi" }, format: "png", preset: "og", scale: "1", v: "2", bg: "grid" },
    );
    await client.close();
    await server.close();
  });

  it("rejects params containing the reserved `sig` key before the handler ever runs", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({
      env: envWith({ signingSecretB64Url: SIGNING_SECRET_B64URL, signingKeyId: "key_1" }),
      client: client_,
    });
    const result = await client.callTool({
      name: "build_image_url",
      arguments: { template: "hero", params: { sig: "forged" } },
    });
    expect(result.isError).toBe(true);
    expect(client_.signImageUrl).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("rejects params containing the reserved `debug` key before the handler ever runs", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({
      env: envWith({ signingSecretB64Url: SIGNING_SECRET_B64URL, signingKeyId: "key_1" }),
      client: client_,
    });
    const result = await client.callTool({
      name: "build_image_url",
      arguments: { template: "hero", params: { debug: "1" } },
    });
    expect(result.isError).toBe(true);
    expect(client_.signImageUrl).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("rejects a `v` value past MAX_V_LENGTH before the handler ever runs", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({
      env: envWith({ signingSecretB64Url: SIGNING_SECRET_B64URL, signingKeyId: "key_1" }),
      client: client_,
    });
    const result = await client.callTool({
      name: "build_image_url",
      arguments: { template: "hero", v: "x".repeat(201) },
    });
    expect(result.isError).toBe(true);
    expect(client_.signImageUrl).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("rejects a `bg` value past MAX_BG_LENGTH before the handler ever runs", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({
      env: envWith({ signingSecretB64Url: SIGNING_SECRET_B64URL, signingKeyId: "key_1" }),
      client: client_,
    });
    const result = await client.callTool({
      name: "build_image_url",
      arguments: { template: "hero", bg: "x".repeat(201) },
    });
    expect(result.isError).toBe(true);
    expect(client_.signImageUrl).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("falls back to an unsigned /p URL with OGMAKE_PUBLIC_KEY_ID when no signing secret is set", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({
      env: envWith({ publicKeyId: "key_pub" }),
      client: client_,
    });
    const result = await client.callTool({ name: "build_image_url", arguments: { template: "hero" } });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe("https://ogmake.com/p/key_pub/hero");
    await client.close();
    await server.close();
  });

  it("errors when neither signing secret nor public key id is configured", async () => {
    const { client, server } = await connectedClient({ env: envWith(), client: fakeClient() });
    const result = await client.callTool({ name: "build_image_url", arguments: { template: "hero" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/no signing secret or public key id/);
    await client.close();
    await server.close();
  });

  it("errors (without echoing the secret) when OGMAKE_SIGNING_SECRET is not valid base64url", async () => {
    // Confirms `base64UrlDecode` really does throw on garbage input (the
    // property build_image_url's error path relies on) before checking the
    // tool call itself never echoes it.
    expect(() => base64UrlDecode("!!!not-base64!!!")).toThrow();

    const { client, server } = await connectedClient({
      env: envWith({ signingSecretB64Url: "!!!not-base64!!!", signingKeyId: "key_1" }),
      client: fakeClient(),
    });
    const result = await client.callTool({ name: "build_image_url", arguments: { template: "hero" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe("OGMAKE_SIGNING_SECRET is not valid base64url");
    expect(content[0]?.text).not.toContain("!!!not-base64!!!");
    await client.close();
    await server.close();
  });

  it("returns isError:true on an SDK throw during signing", async () => {
    const { client, server } = await connectedClient({
      env: envWith({ signingSecretB64Url: SIGNING_SECRET_B64URL, signingKeyId: "key_1" }),
      client: fakeClient({
        signImageUrl: vi.fn(async () => {
          throw new Error("crypto blew up");
        }),
      }),
    });
    const result = await client.callTool({ name: "build_image_url", arguments: { template: "hero" } });
    expect(result.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it("rejects an oversized params object before touching the SDK", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({
      env: envWith({ publicKeyId: "key_pub" }),
      client: client_,
    });
    const params: Record<string, string> = {};
    for (let i = 0; i < 21; i++) params[`k${i}`] = "v";
    const result = await client.callTool({ name: "build_image_url", arguments: { template: "hero", params } });
    expect(result.isError).toBe(true);
    expect(client_.publicImageUrl).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });
});

describe("og_snippet", () => {
  it("renders a snippet for a valid framework/url", async () => {
    const { client, server } = await connectedClient({ env: envWith(), client: fakeClient() });
    const result = await client.callTool({
      name: "og_snippet",
      arguments: { framework: "html", imageUrl: "https://ogmake.com/o/abc.png" },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("og:image");
    await client.close();
    await server.close();
  });

  it("rejects an unknown framework as a validation error (isError, not a thrown promise)", async () => {
    const { client, server } = await connectedClient({ env: envWith(), client: fakeClient() });
    const result = await client.callTool({
      name: "og_snippet",
      arguments: { framework: "nextjs", imageUrl: "https://ogmake.com/o/abc.png" },
    });
    expect(result.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it("rejects a malformed imageUrl", async () => {
    const { client, server } = await connectedClient({ env: envWith(), client: fakeClient() });
    const result = await client.callTool({
      name: "og_snippet",
      arguments: { framework: "html", imageUrl: "not a url" },
    });
    expect(result.isError).toBe(true);
    await client.close();
    await server.close();
  });
});

const PREVIEW = async () => ({ data: "AAEC", mimeType: "image/png" });

describe("render_html", () => {
  const args = { html: "<h1>Hi</h1>", width: 1200, height: 630 };

  it("errors locally with no network call when OGMAKE_API_KEY is unset", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({ env: envWith(), client: client_ });
    const result = await client.callTool({ name: "render_html", arguments: args });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text?: string }>)[0]?.text).toMatch(/OGMAKE_API_KEY is not configured/);
    expect(client_.renderHtml).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("renders via the SDK and returns JSON plus an inline preview", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: client_, fetchImageBytes: PREVIEW });
    const result = await client.callTool({ name: "render_html", arguments: { ...args, css: "h1{color:red}", format: "webp" } });
    expect(result.isError).not.toBe(true);
    expect(client_.renderHtml).toHaveBeenCalledWith({ html: "<h1>Hi</h1>", css: "h1{color:red}", width: 1200, height: 630, format: "webp" });
    const content = result.content as Array<{ type: string; text?: string; data?: string }>;
    expect(JSON.parse(content[0]!.text!)).toMatchObject({ credits: 2 });
    expect(content[1]).toMatchObject({ type: "image", data: "AAEC" });
    await client.close();
    await server.close();
  });

  it("omits optional args and degrades to text-only when the preview fetch fails (e.g. a PDF)", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({
      env: envWith({ apiKey: SECRET }),
      client: client_,
      fetchImageBytes: async () => {
        throw new Error("not an image");
      },
    });
    const result = await client.callTool({ name: "render_html", arguments: args });
    expect(client_.renderHtml).toHaveBeenCalledWith({ html: "<h1>Hi</h1>", width: 1200, height: 630 });
    expect(result.content).toHaveLength(1);
    await client.close();
    await server.close();
  });

  it("rejects an oversized html locally (schema), and surfaces API errors as isError", async () => {
    const client_ = fakeClient({
      renderHtml: vi.fn(async () => {
        throw new OgmakeApiError("quota_exceeded", 429);
      }),
    });
    const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: client_ });
    const big = await client.callTool({ name: "render_html", arguments: { ...args, html: "x".repeat(250_001) } });
    expect(big.isError).toBe(true);
    expect(client_.renderHtml).not.toHaveBeenCalled();
    const failed = await client.callTool({ name: "render_html", arguments: args });
    expect(failed.isError).toBe(true);
    expect((failed.content as Array<{ text?: string }>)[0]?.text).toContain("quota_exceeded");
    await client.close();
    await server.close();
  });
});

describe("create_batch / get_batch / font", () => {
  const items = [
    { template: "basic", params: { title: "A" }, format: "webp", preset: "x", scale: "2", v: "1", bg: "bg-01", font: "Lobster" },
    { template: "basic" },
  ];

  it("both need OGMAKE_API_KEY and make no SDK call without it", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({ env: envWith(), client: client_ });
    for (const call of [
      { name: "create_batch", arguments: { items } },
      { name: "get_batch", arguments: { batchId: "bat_1" } },
    ]) {
      const result = await client.callTool(call);
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text?: string }>)[0]?.text).toMatch(/OGMAKE_API_KEY is not configured/);
    }
    expect(client_.createBatch).not.toHaveBeenCalled();
    expect(client_.getBatch).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("create_batch forwards items (every field) and webhookUrl; get_batch returns the status JSON", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: client_ });
    const started = await client.callTool({ name: "create_batch", arguments: { items, webhookUrl: "https://hook.example/x" } });
    expect(started.isError).not.toBe(true);
    expect(client_.createBatch).toHaveBeenCalledWith({ items, webhookUrl: "https://hook.example/x" });
    expect(JSON.parse((started.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ batch_id: "bat_1", total: 2 });
    await client.callTool({ name: "create_batch", arguments: { items: [{ template: "basic" }] } });
    expect(client_.createBatch).toHaveBeenLastCalledWith({ items: [{ template: "basic" }] });

    const status = await client.callTool({ name: "get_batch", arguments: { batchId: "bat_1" } });
    expect(client_.getBatch).toHaveBeenCalledWith("bat_1");
    expect(JSON.parse((status.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ status: "completed", succeeded: 1 });
    await client.close();
    await server.close();
  });

  it("validates locally (empty / over-500 items) and surfaces API errors as isError", async () => {
    const client_ = fakeClient({
      createBatch: vi.fn(async () => {
        throw new OgmakeApiError("too_many_batches", 429);
      }),
      getBatch: vi.fn(async () => {
        throw new OgmakeApiError("not_found", 404);
      }),
    });
    const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: client_ });
    expect((await client.callTool({ name: "create_batch", arguments: { items: [] } })).isError).toBe(true);
    expect((await client.callTool({ name: "create_batch", arguments: { items: Array.from({ length: 501 }, () => ({ template: "basic" })) } })).isError).toBe(true);
    expect(client_.createBatch).not.toHaveBeenCalled();
    const failed = await client.callTool({ name: "create_batch", arguments: { items } });
    expect((failed.content as Array<{ text?: string }>)[0]?.text).toContain("too_many_batches");
    const missing = await client.callTool({ name: "get_batch", arguments: { batchId: "bat_x" } });
    expect((missing.content as Array<{ text?: string }>)[0]?.text).toContain("not_found");
    await client.close();
    await server.close();
  });

  it("render_image and build_image_url pass `font` through", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({
      env: envWith({ apiKey: SECRET, signingSecretB64Url: SIGNING_SECRET_B64URL, signingKeyId: "key_1" }),
      client: client_,
      fetchImageBytes: PREVIEW,
    });
    await client.callTool({ name: "render_image", arguments: { template: "hero", font: "Lobster" } });
    expect(client_.renderImage).toHaveBeenCalledWith({ template: "hero", font: "Lobster" });
    await client.callTool({ name: "build_image_url", arguments: { template: "hero", font: "Lobster" } });
    expect(client_.signImageUrl).toHaveBeenCalledWith("key_1", expect.any(Uint8Array), { template: "hero", font: "Lobster" });
    await client.close();
    await server.close();
  });
});

describe("get_usage", () => {
  it("errors locally with no network call when OGMAKE_API_KEY is unset", async () => {
    const client_ = fakeClient();
    const { client, server } = await connectedClient({ env: envWith(), client: client_ });
    const result = await client.callTool({ name: "get_usage", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/OGMAKE_API_KEY is not configured/);
    expect(client_.getUsage).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("returns usage JSON when authenticated", async () => {
    const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: fakeClient() });
    const result = await client.callTool({ name: "get_usage", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(JSON.parse(content[0]?.text ?? "")).toMatchObject({ plan: "starter" });
    await client.close();
    await server.close();
  });

  it("returns isError:true on an unauthorized API error", async () => {
    const { client, server } = await connectedClient({
      env: envWith({ apiKey: SECRET }),
      client: fakeClient({
        getUsage: vi.fn(async () => {
          throw new OgmakeApiError("unauthorized", 401);
        }),
      }),
    });
    const result = await client.callTool({ name: "get_usage", arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
    await server.close();
  });
});

describe("buildServer default wiring", () => {
  const EXPECTED_TOOLS = [
    "build_image_url",
    "create_batch",
    "get_batch",
    "get_usage",
    "list_templates",
    "og_snippet",
    "render_html",
    "render_image",
  ];

  it("builds a real @ogmake/sdk client from readEnv() when no overrides are passed", async () => {
    // Exercises the default-options branch (no options object at all,
    // apiKey/baseUrl both unset) — proven by actually connecting a client
    // and listing tools (construction alone doesn't prove the server wired
    // up correctly; a real tool-list round-trip does), not just that the
    // constructor didn't throw.
    const server = buildServer();
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    await client.close();
    await server.close();
  });

  it("builds a real client with apiKey/baseUrl forwarded when set and no client override is given", async () => {
    // Covers the opposite branch of the same conditional spreads above —
    // apiKey/baseUrl both SET, still no `client`/`fetchImageBytes` override —
    // again proven via a real tool-list round-trip rather than a bare
    // construct-and-truthy check.
    const server = buildServer({ env: envWith({ apiKey: SECRET, baseUrl: "https://example.test" }) });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    await client.close();
    await server.close();
  });

  it("defaultFetchImageBytes: fetches and base64-encodes a real image/* response", async () => {
    const png = new Uint8Array([1, 2, 3]);
    let seenInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seenInit = init;
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }),
    );
    try {
      const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: fakeClient() });
      const result = await client.callTool({ name: "render_image", arguments: { template: "hero" } });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; mimeType?: string; data?: string }>;
      expect(content[1]?.type).toBe("image");
      expect(content[1]?.mimeType).toBe("image/png");
      expect(content[1]?.data).toBe(Buffer.from(png).toString("base64"));
      // Opus review minors: never follows a redirect, always carries a
      // per-request abort/timeout signal.
      expect(seenInit?.redirect).toBe("manual");
      expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
      await client.close();
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaultFetchImageBytes: degrades render_image to text-only when the response omits content-type", async () => {
    const png = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(png, { status: 200 })),
    );
    try {
      const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: fakeClient() });
      const result = await client.callTool({ name: "render_image", arguments: { template: "hero" } });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      await client.close();
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaultFetchImageBytes: degrades render_image to text-only when the content-type isn't image/*", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "text/html" } })),
    );
    try {
      const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: fakeClient() });
      const result = await client.callTool({ name: "render_image", arguments: { template: "hero" } });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      await client.close();
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaultFetchImageBytes: degrades render_image to text-only when Content-Length exceeds the byte cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: { "content-type": "image/png", "content-length": String(6 * 1024 * 1024) },
          }),
      ),
    );
    try {
      const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: fakeClient() });
      const result = await client.callTool({ name: "render_image", arguments: { template: "hero" } });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      await client.close();
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaultFetchImageBytes: degrades render_image to text-only when the actual body exceeds the byte cap", async () => {
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(oversized, { status: 200, headers: { "content-type": "image/png" } }),
      ),
    );
    try {
      const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: fakeClient() });
      const result = await client.callTool({ name: "render_image", arguments: { template: "hero" } });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      await client.close();
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaultFetchImageBytes: throws (degrading render_image to text-only) on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 502 })),
    );
    try {
      const { client, server } = await connectedClient({ env: envWith({ apiKey: SECRET }), client: fakeClient() });
      const result = await client.callTool({ name: "render_image", arguments: { template: "hero" } });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      await client.close();
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("secret-leak sweep", () => {
  it("never echoes OGMAKE_API_KEY or the signing secret across every tool's success/error paths", async () => {
    const forbidden = [SECRET, SIGNING_SECRET_B64URL, SIGNING_SECRET_LITERAL];
    const { client, server } = await connectedClient({
      env: envWith({
        apiKey: SECRET,
        signingSecretB64Url: SIGNING_SECRET_B64URL,
        signingKeyId: "key_1",
        publicKeyId: "key_pub",
      }),
      client: fakeClient({
        renderImage: vi.fn(async () => {
          throw new OgmakeApiError("unauthorized", 401);
        }),
        listTemplates: vi.fn(async () => {
          throw new OgmakeApiError("render_unavailable", 503);
        }),
        getUsage: vi.fn(async () => {
          throw new OgmakeNetworkError(new Error("network down"));
        }),
        signImageUrl: vi.fn(async () => {
          throw new Error("signing failed");
        }),
      }),
      fetchImageBytes: vi.fn(async () => {
        throw new Error("img fetch failed");
      }),
    });

    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: "list_templates", arguments: {} },
      { name: "render_image", arguments: { template: "hero" } },
      { name: "build_image_url", arguments: { template: "hero" } },
      { name: "og_snippet", arguments: { framework: "html", imageUrl: "https://ogmake.com/o/x.png" } },
      { name: "get_usage", arguments: {} },
    ];

    for (const call of calls) {
      const result = await client.callTool(call);
      const text = JSON.stringify(result);
      for (const secret of forbidden) {
        expect(text).not.toContain(secret);
      }
    }

    await client.close();
    await server.close();
  });
});
