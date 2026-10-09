// packages/mcp/src/server.ts — ogmake-mcp's eight tools, built on
// @ogmake/sdk (decisions-2026-09-22 item 3): list_templates, render_image,
// render_html, build_image_url, og_snippet, get_usage, plus the
// async batch pair create_batch / get_batch.
// Local stdio only; see README.md for the `npx --yes file:<tarball>` install shape (spike-mcp/RESULTS.md).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createClient,
  ogSnippet,
  OGMAKE_SDK_VERSION,
  OgmakeApiError,
  OgmakeNetworkError,
  OgmakeRedirectError,
  SNIPPET_FRAMEWORKS,
  type OgmakeClient,
  type SnippetFramework,
} from "@ogmake/sdk";
import {
  base64UrlDecode,
  MAX_BG_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_IMAGE_URL_LENGTH,
  MAX_PARAM_KEYS,
  MAX_PARAM_VALUE_LENGTH,
  MAX_SITE_LENGTH,
  MAX_TEMPLATE_ID_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_V_LENGTH,
  readEnv,
  RESERVED_PARAM_KEYS,
  type OgmakeEnv,
} from "./env";

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolResult = { isError?: boolean; content: Array<TextContent | ImageContent> };

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Turns any error this server can throw into a safe, non-secret-leaking
 * tool-error message. `OgmakeApiError`'s `code`/`status`/`detail` come from
 * the API's own JSON error body, which never echoes a caller's Authorization
 * header or secret back to them — safe to surface verbatim. Every other
 * error path (network failure, redirect refusal, a local validation throw)
 * only ever carries a message this module itself wrote, never an env var
 * value — see server.test.ts's secret-leak sweep. */
function describeError(err: unknown): string {
  if (err instanceof OgmakeApiError) {
    const detail = err.detail?.map((d) => `${d.field}: ${d.message}`).join("; ");
    return detail ? `ogmake API error: ${err.code} (${detail})` : `ogmake API error: ${err.code}`;
  }
  if (err instanceof OgmakeNetworkError || err instanceof OgmakeRedirectError) {
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "unknown error";
}

const paramsSchema = z
  .record(z.string().max(MAX_PARAM_VALUE_LENGTH))
  .refine((p) => Object.keys(p).length <= MAX_PARAM_KEYS, {
    message: `params has more than ${MAX_PARAM_KEYS} keys`,
  })
  .refine((p) => Object.keys(p).every((k) => !RESERVED_PARAM_KEYS.has(k)), {
    message: `params must not include reserved keys: ${Array.from(RESERVED_PARAM_KEYS).join(", ")}`,
  })
  .optional();

const formatSchema = z.enum(["png", "jpg", "webp", "pdf"]).optional();
const presetSchema = z.enum(["og", "x", "square"]).optional();
const scaleSchema = z.enum(["1", "2"]).optional();
const vSchema = z.string().max(MAX_V_LENGTH).optional();
const bgSchema = z.string().max(MAX_BG_LENGTH).optional();
const fontSchema = z.string().min(1).max(64).optional().describe("A Google Fonts family name, e.g. Playfair Display.");

// POST /v1/images {html} body cap is 300 KB in total; leave headroom for the
// JSON envelope so a maximal `html` + `css` pair is rejected here, locally,
// instead of as a 413 round-trip.
const MAX_HTML_LENGTH = 250_000;
const MAX_CSS_LENGTH = 40_000;
const dimensionSchema = z.number().int().min(16).max(4096);

export interface BuildServerOptions {
  env?: OgmakeEnv;
  /** DI seam for tests: a fake @ogmake/sdk client instead of a real one. */
  client?: OgmakeClient;
  /** DI seam for tests: fetches the hosted URL `renderImage` returns, to
   * embed as the tool's own image content block. Defaults to the ambient
   * global `fetch`. */
  fetchImageBytes?: (url: string) => Promise<{ data: string; mimeType: string }>;
}

// Opus review minors: this fetches whatever URL the API's own render
// response handed back (`rendered.url`) and hands its bytes straight to
// the MCP client as an inline image — hardened the same way any
// server-controlled-but-externally-hosted fetch should be: no redirect
// (a compromised/misconfigured render host could otherwise point this at
// an internal/arbitrary origin), a real image content-type (never trust
// the extension/URL shape alone), a hard byte cap so a pathological or
// hostile response can't be buffered into memory unbounded, and a fetch
// timeout so a hung origin can't block the tool call forever.
const MAX_IMAGE_FETCH_BYTES = 5 * 1024 * 1024; // 5 MB
const IMAGE_FETCH_TIMEOUT_MS = 20_000;

/** Best-effort body cancel on a reject path (non-ok / bad content-type / bad
 * content-length) — undici/workerd hold the connection open for an
 * unread-but-not-cancelled body. Shared by all three reject sites below so
 * their branch coverage (body present vs. absent, e.g. a null-body 502) adds
 * up across the suite instead of each call site needing its own pair of
 * tests. Fire-and-forget: never blocks the throw on cancel settling. */
function cancelBody(response: Response): void {
  response.body?.cancel().catch(() => {});
}

/** Reads a response body incrementally via its stream reader and aborts as
 * soon as the running total crosses `capBytes` — a true streaming cap,
 * independent of `Content-Length` (which a hostile or misconfigured origin
 * can simply omit or lie about), and never buffers more than `capBytes`
 * (+ one in-flight chunk) into memory. Cancels the stream on overflow so the
 * connection isn't left half-read. Only called after an ok, image/*-typed
 * response, which always carries a body stream on every runtime this ships
 * on (Node/undici, workerd) — no no-body fallback, to keep dead code out of
 * the 100%-coverage gate. */
async function readCappedBytes(response: Response, capBytes: number, overflowMessage: string): Promise<Buffer> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(overflowMessage);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
}

async function defaultFetchImageBytes(url: string): Promise<{ data: string; mimeType: string }> {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    cancelBody(response);
    throw new Error(`fetching rendered image failed: HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    cancelBody(response);
    throw new Error(`fetching rendered image failed: unexpected content-type "${contentType}"`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_IMAGE_FETCH_BYTES) {
    cancelBody(response);
    throw new Error(`fetching rendered image failed: response exceeds ${MAX_IMAGE_FETCH_BYTES} bytes`);
  }
  const buf = await readCappedBytes(
    response,
    MAX_IMAGE_FETCH_BYTES,
    `fetching rendered image failed: response exceeds ${MAX_IMAGE_FETCH_BYTES} bytes`,
  );
  return { data: buf.toString("base64"), mimeType: contentType };
}

export function buildServer(options: BuildServerOptions = {}): McpServer {
  const env = options.env ?? readEnv();
  const client =
    options.client ??
    createClient({
      ...(env.apiKey ? { apiKey: env.apiKey } : {}),
      ...(env.baseUrl ? { baseUrl: env.baseUrl } : {}),
    });
  const fetchImageBytes = options.fetchImageBytes ?? defaultFetchImageBytes;

  // Opus review minor: sourced from @ogmake/sdk's own version constant
  // rather than a second hardcoded "0.1.0" literal here, so the two can't
  // silently drift out of sync.
  const server = new McpServer({ name: "ogmake-mcp", version: OGMAKE_SDK_VERSION });

  server.registerTool(
    "list_templates",
    {
      title: "List OG templates",
      description: "Lists every registered og:image template id, version, and its params JSON Schema.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const result = await client.listTemplates();
        return textResult(JSON.stringify(result));
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    "render_image",
    {
      title: "Render an OG image",
      description:
        "Renders an og:image. With OGMAKE_API_KEY configured, renders `template` via the authenticated " +
        "API and returns its hosted URL plus the image bytes. With no key, renders a watermarked free " +
        "image from `title` (and optional `description`/`site`) and returns image bytes only.",
      inputSchema: {
        template: z.string().min(1).max(MAX_TEMPLATE_ID_LENGTH).optional().describe(
          "Template id (authenticated mode only, requires OGMAKE_API_KEY).",
        ),
        params: paramsSchema.describe("Template params (authenticated mode only)."),
        title: z.string().min(1).max(MAX_TITLE_LENGTH).optional().describe(
          "Title text (free/unauthenticated mode only).",
        ),
        description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH).optional(),
        site: z.string().min(1).max(MAX_SITE_LENGTH).optional(),
        format: formatSchema,
        preset: presetSchema,
        scale: scaleSchema,
        v: vSchema,
        bg: bgSchema,
        font: fontSchema,
      },
    },
    async (args): Promise<ToolResult> => {
      // Param caps (MAX_PARAM_KEYS/MAX_PARAM_VALUE_LENGTH) are enforced by
      // paramsSchema itself (a zod `.refine()` + per-value `.max()`) at the
      // MCP-protocol boundary, before this handler ever runs — see
      // og_snippet's comment for the same "SDK validates first" pattern.
      try {
        if (env.apiKey) {
          if (!args.template) {
            return errorResult("`template` is required when OGMAKE_API_KEY is configured");
          }
          const rendered = await client.renderImage({
            template: args.template,
            ...(args.params ? { params: args.params } : {}),
            ...(args.format ? { format: args.format } : {}),
            ...(args.preset ? { preset: args.preset } : {}),
            ...(args.scale ? { scale: args.scale } : {}),
            ...(args.v ? { v: args.v } : {}),
            ...(args.bg ? { bg: args.bg } : {}),
            ...(args.font ? { font: args.font } : {}),
          });
          let imageContent: ImageContent[] = [];
          try {
            const bytes = await fetchImageBytes(rendered.url);
            imageContent = [{ type: "image", data: bytes.data, mimeType: bytes.mimeType }];
          } catch {
            // The render itself succeeded (we have a URL + metadata) — a
            // failure fetching it back for the inline preview degrades to
            // text-only rather than failing the whole tool call.
          }
          return {
            content: [{ type: "text", text: JSON.stringify(rendered) }, ...imageContent],
          };
        }

        if (!args.title) {
          return errorResult("`title` is required when no OGMAKE_API_KEY is configured (free render)");
        }
        const free = await client.freeRender({
          title: args.title,
          ...(args.description ? { description: args.description } : {}),
          ...(args.site ? { site: args.site } : {}),
        });
        return {
          content: [
            {
              type: "image",
              data: Buffer.from(free.bytes).toString("base64"),
              mimeType: free.contentType,
            },
          ],
        };
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  /** Best-effort inline preview of a stored render (image content-types
   * only): any failure degrades to text-only, never fails the tool call. */
  async function previewContent(url: string): Promise<ImageContent[]> {
    try {
      const bytes = await fetchImageBytes(url);
      return [{ type: "image", data: bytes.data, mimeType: bytes.mimeType }];
    } catch {
      return [];
    }
  }

  server.registerTool(
    "render_html",
    {
      title: "Render HTML to an image",
      description:
        "Renders raw HTML/CSS to a stored PNG/JPG/WebP/PDF via POST /v1/images (2 credits; requires " +
        "OGMAKE_API_KEY). JavaScript never runs; at most 3 external http(s) subresources load, each through " +
        "an SSRF-safe fetcher; the request body is limited to 300 KB. Returns the hosted URL plus an inline preview.",
      inputSchema: {
        html: z.string().min(1).max(MAX_HTML_LENGTH).describe("HTML document or fragment to render."),
        css: z.string().max(MAX_CSS_LENGTH).optional().describe("Extra CSS, injected as a <style> block."),
        width: dimensionSchema.describe("Viewport width in CSS px (16-4096)."),
        height: dimensionSchema.describe("Viewport height in CSS px (16-4096)."),
        format: formatSchema,
      },
    },
    async (args): Promise<ToolResult> => {
      if (!env.apiKey) {
        return errorResult("OGMAKE_API_KEY is not configured");
      }
      try {
        const rendered = await client.renderHtml({
          html: args.html,
          ...(args.css ? { css: args.css } : {}),
          width: args.width,
          height: args.height,
          ...(args.format ? { format: args.format } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(rendered) }, ...(await previewContent(rendered.url))] };
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    "create_batch",
    {
      title: "Start an async image batch",
      description:
        "Starts an async batch of up to 500 template renders via POST /v1/batch (requires OGMAKE_API_KEY). " +
        "Returns immediately with a batch_id; poll it with get_batch. Credits are charged per rendered item " +
        "(cache hits are free) and refunded per failed item. Optional webhookUrl (https) is notified with a " +
        "signed `batch.completed` event.",
      inputSchema: {
        items: z
          .array(
            z.object({
              template: z.string().min(1).max(MAX_TEMPLATE_ID_LENGTH),
              params: paramsSchema,
              format: formatSchema,
              preset: presetSchema,
              scale: scaleSchema,
              v: vSchema,
              bg: bgSchema,
              font: fontSchema,
            }),
          )
          .min(1)
          .max(500),
        webhookUrl: z.string().url().max(2048).optional().describe("https URL notified when the batch completes."),
      },
    },
    async (args): Promise<ToolResult> => {
      if (!env.apiKey) {
        return errorResult("OGMAKE_API_KEY is not configured");
      }
      try {
        const started = await client.createBatch({
          items: args.items.map((item) => ({
            template: item.template,
            ...(item.params ? { params: item.params } : {}),
            ...(item.format ? { format: item.format } : {}),
            ...(item.preset ? { preset: item.preset } : {}),
            ...(item.scale ? { scale: item.scale } : {}),
            ...(item.v ? { v: item.v } : {}),
            ...(item.bg ? { bg: item.bg } : {}),
            ...(item.font ? { font: item.font } : {}),
          })),
          ...(args.webhookUrl ? { webhookUrl: args.webhookUrl } : {}),
        });
        return textResult(JSON.stringify(started));
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    "get_batch",
    {
      title: "Get an async batch's status",
      description:
        "Fetches a batch's status via GET /v1/batch/{id} (requires OGMAKE_API_KEY): overall status and counts, plus " +
        "each item's stored URL (succeeded) or error and message (failed).",
      inputSchema: { batchId: z.string().min(1).max(64) },
    },
    async (args): Promise<ToolResult> => {
      if (!env.apiKey) {
        return errorResult("OGMAKE_API_KEY is not configured");
      }
      try {
        return textResult(JSON.stringify(await client.getBatch(args.batchId)));
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    "build_image_url",
    {
      title: "Build an OG image URL",
      description:
        "Builds an image URL for `template` without rendering it: signed locally (OGMAKE_SIGNING_SECRET + " +
        "OGMAKE_SIGNING_KEY_ID) or an unsigned /p URL (OGMAKE_PUBLIC_KEY_ID) when no signing secret is set.",
      inputSchema: {
        template: z.string().min(1).max(MAX_TEMPLATE_ID_LENGTH),
        params: paramsSchema,
        format: formatSchema,
        preset: presetSchema,
        scale: scaleSchema,
        v: vSchema,
        bg: bgSchema,
        font: fontSchema,
      },
    },
    async (args): Promise<ToolResult> => {
      // See render_image's identical comment above: paramsSchema enforces
      // both param caps before this handler runs.
      try {
        if (env.signingSecretB64Url && env.signingKeyId) {
          let secretBytes: Uint8Array;
          try {
            secretBytes = base64UrlDecode(env.signingSecretB64Url);
          } catch {
            return errorResult("OGMAKE_SIGNING_SECRET is not valid base64url");
          }
          const url = await client.signImageUrl(env.signingKeyId, secretBytes, {
            template: args.template,
            ...(args.params ? { params: args.params } : {}),
            ...(args.format ? { format: args.format } : {}),
            ...(args.preset ? { preset: args.preset } : {}),
            ...(args.scale ? { scale: args.scale } : {}),
            ...(args.v ? { v: args.v } : {}),
            ...(args.bg ? { bg: args.bg } : {}),
            ...(args.font ? { font: args.font } : {}),
          });
          return textResult(url);
        }

        if (env.publicKeyId) {
          return textResult(client.publicImageUrl(env.publicKeyId, args.template));
        }

        return errorResult(
          "no signing secret or public key id configured — set OGMAKE_SIGNING_SECRET + " +
            "OGMAKE_SIGNING_KEY_ID, or OGMAKE_PUBLIC_KEY_ID",
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    "og_snippet",
    {
      title: "og:image HTML snippet",
      description: "Renders the og:image + twitter:image meta tag snippet for a framework, given an image URL.",
      inputSchema: {
        framework: z.enum(SNIPPET_FRAMEWORKS as unknown as [string, ...string[]]),
        imageUrl: z.string().min(1).max(MAX_IMAGE_URL_LENGTH).url(),
      },
    },
    async (args): Promise<ToolResult> => {
      // The `framework` enum schema above already restricts input to
      // exactly SNIPPET_FRAMEWORKS at the MCP-protocol boundary — a bad
      // value never reaches this handler (the SDK turns it into an
      // isError:true validation result first, per spike-mcp/RESULTS.md
      // #1), so this cast documents that invariant instead of an
      // unreachable runtime `isSnippetFramework` branch.
      return textResult(ogSnippet(args.framework as SnippetFramework, args.imageUrl));
    },
  );

  server.registerTool(
    "get_usage",
    {
      title: "Get account usage",
      description: "Fetches the current billing period's render usage/quota for the OGMAKE_API_KEY account.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      if (!env.apiKey) {
        return errorResult("OGMAKE_API_KEY is not configured");
      }
      try {
        const usage = await client.getUsage();
        return textResult(JSON.stringify(usage));
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  return server;
}
