// @ogmake/sdk — real client (P6). Thin fetch wrapper over the public API
// (apps/api): POST /v1/images, GET /v1/templates, GET /v1/usage, GET
// /v1/free/og. No transitive dependency on @ogmake/core's server-only
// pieces beyond the pure signing helpers (`signQuery`), which are also
// what `packages/mcp` bundles for local signing — see decisions-2026-09-22.md
// item 3.
import { canonicalQuery, signQuery } from "@ogmake/core/src/signing";
import { OGMAKE_SDK_VERSION } from "./version";
import { OgmakeApiError, OgmakeNetworkError, OgmakeRedirectError, toApiError } from "./errors";

export const DEFAULT_BASE_URL = "https://ogmake.com";

export type FetchLike = typeof fetch;

export interface CreateClientOptions {
  /** Bearer API key (`og_live_...`). Omit for the free/anonymous surface
   * only (`freeRender`, `listTemplates`) — `renderImage`/`getUsage` throw
   * `OgmakeApiError("unauthenticated", 0)` locally, without a network call,
   * when no key is configured. */
  apiKey?: string;
  /** API origin. Defaults to the production API; override for a local
   * `wrangler dev` instance (tests, this package's own e2e suite). */
  baseUrl?: string;
  /** Injectable `fetch` (tests, non-global runtimes). Defaults to the
   * ambient global `fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout (ms), applied to every fetch this client makes
   * via `AbortSignal.timeout` — a hung API/origin must never block a
   * caller (e.g. ogmake-mcp's stdio tool handlers) forever. Opus review
   * minor: previously unbounded. When set, it also applies to
   * `autoImage`; when omitted, `autoImage` uses
   * {@link DEFAULT_AUTO_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
/** `autoImage`'s default timeout: a first card reads the page, styles it
 * after the site and may wait for a concurrent request for the same page
 * (up to about two minutes server side). A client that gives up earlier
 * may still be charged for the card it never saw; retry with the same
 * `idempotencyKey` to get it. */
export const DEFAULT_AUTO_TIMEOUT_MS = 180_000;
const MAX_FREE_RENDER_BYTES = 5 * 1024 * 1024; // 5 MB

/** Re-review fix: mirrors packages/mcp/src/server.ts's `readCappedBytes` —
 * reads the body stream incrementally and aborts as soon as the running
 * total crosses `capBytes`, a true streaming cap independent of
 * `Content-Length` (never trusted alone — see the header check below), and
 * cancels the stream on overflow instead of buffering it fully first. Only
 * called after an ok, image/*-typed response, which always carries a body
 * stream on every runtime this ships on (Node/undici, workerd) — no no-body
 * fallback, to keep dead code out of the 100%-coverage gate. */
async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

async function readCappedBytes(response: Response, capBytes: number, overflowMessage: string): Promise<Uint8Array> {
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
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type ImageParamValue = string | number | string[];

export interface RenderImageOptions {
  template: string;
  params?: Record<string, ImageParamValue>;
  format?: "png" | "jpg" | "webp" | "pdf";
  preset?: "og" | "x" | "square";
  scale?: "1" | "2";
  v?: string;
  bg?: string;
  /** A Google Fonts family name, e.g. `"Playfair Display"`. */
  font?: string;
}

/** POST /v1/images in async mode: the API answers 202 and POSTs the outcome
 * (`image.completed` / `image.failed`) to `webhookUrl`. */
export interface RenderImageAsyncOptions extends RenderImageOptions {
  /** `https://` URL; checked by the API's SSRF guard. */
  webhookUrl: string;
}

export interface RenderImageAsyncResult {
  request_id: string;
  status: "processing";
}

/** One image of a batch: the same fields as {@link RenderImageOptions}. */
export type BatchItem = RenderImageOptions;

export interface CreateBatchOptions {
  /** 1 to 500 items. */
  items: BatchItem[];
  /** `https://` URL notified with `batch.completed`. */
  webhookUrl?: string;
}

export interface CreateBatchResult {
  batch_id: string;
  status: "queued";
  total: number;
  status_url: string;
}

export interface BatchItemResult {
  index: number;
  template: string;
  status: "queued" | "running" | "succeeded" | "failed";
  url?: string;
  hash?: string;
  cached?: boolean;
  error?: string;
  message?: string | null;
}

export interface WebhookDeliverySummary {
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  next_attempt_at: number | null;
  delivered_at: number | null;
}

export interface BatchStatusResult {
  batch_id: string;
  status: "queued" | "running" | "completed";
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  created_at: number;
  completed_at: number | null;
  webhook: { url: string; delivery: WebhookDeliverySummary | null } | null;
  items: BatchItemResult[];
}

export interface WebhookDelivery extends WebhookDeliverySummary {
  id: string;
  event: string;
  url: string;
  created_at: number;
  batch_id: string | null;
}

export interface ListWebhookDeliveriesOptions {
  batchId?: string;
  /** 1 to 100 (API default 20). */
  limit?: number;
}

export interface RenderImageResult {
  url: string;
  hash: string;
  cached: boolean;
  width: number;
  height: number;
  format: string;
  bytes: number;
  templateVersion: string;
}

/** POST /v1/images with raw HTML (2 credits). Mutually exclusive with a
 * template render; JavaScript never runs, at most 3 external subresources
 * load, and the request body is limited to 300 KB. */
export interface RenderHtmlOptions {
  html: string;
  css?: string;
  /** CSS px, 16-4096. */
  width: number;
  /** CSS px, 16-4096. */
  height: number;
  format?: "png" | "jpg" | "webp" | "pdf";
}

export interface RenderHtmlResult {
  url: string;
  hash: string;
  cached: false;
  width: number;
  height: number;
  format: string;
  bytes: number;
  credits: number;
}

export interface TemplateDescriptor {
  id: string;
  version: string;
  params: unknown;
}

export interface ListTemplatesResult {
  templates: TemplateDescriptor[];
}

export interface UsageResult {
  plan: string;
  period: string;
  credits: number;
  cap: number;
  hardCap: number;
  remaining: number;
  overCapSince: number | null;
  /** Credits carried in from last month (paid plans); spent first. Already included in `remaining`/`hardCap`. */
  rolledOver: number;
}

export interface FreeRenderOptions {
  title: string;
  description?: string;
  site?: string;
}

export interface FreeRenderResult {
  bytes: Uint8Array;
  contentType: string;
}

export interface CheckFinding {
  id: string;
  severity: "error" | "warning" | "tip";
  message: string;
  fix?: string;
}

/** Structured result returned by GET /v1/check. Fields produced by the
 * service are intentionally preserved so callers can surface new additive
 * checker details without losing the stable typed fields below. */
export interface CheckLinkPreviewResult {
  url: string;
  finalUrl: string;
  status: number;
  og: Record<string, string>;
  twitter: Record<string, string>;
  warnings: Array<{ code: string; message: string }>;
  findings: CheckFinding[];
  score: number;
  verdict: "ready" | "good" | "needs_work" | "broken";
  counts: { errors: number; warnings: number; tips: number };
  [key: string]: unknown;
}

export interface SignImageUrlOptions {
  baseUrl?: string;
  template: string;
  params?: Record<string, string>;
  format?: "png" | "jpg" | "webp" | "pdf";
  preset?: "og" | "x" | "square";
  scale?: "1" | "2";
  v?: string;
  bg?: string;
  /** A Google Fonts family name; part of the signed canonical query. */
  font?: string;
}

/** Auto mode: ogmake reads the page at `url` and builds its card. */
export interface AutoImageOptions {
  /** Absolute `http(s)://` URL of the page the card is for. */
  url: string;
  /** Optional template id; the API picks one from the page when omitted. */
  template?: string;
  /** Sent as the `Idempotency-Key` header: a retry with the same key and
   * payload within 24 hours replays the first response instead of rendering
   * again (409 `idempotency_conflict` for another payload, 409
   * `idempotency_in_progress` with `Retry-After` while the first request
   * still runs). An error response is never kept: a retry runs again. */
  idempotencyKey?: string;
  /** Per-call timeout (ms). Defaults to the client's `timeoutMs`, else
   * {@link DEFAULT_AUTO_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** POST /v1/images `{auto: true, url}`: the stored-render shape plus the
 * auto-mode fields. */
export interface AutoImageResult extends RenderImageResult {
  /** Credits this call charged: 3 when the page (or the card's own
   * content) was billed, once per 90 days, whether the card was rendered
   * or already cached; plus 2 for a request with a new AI hint; 0 inside the
   * window. */
  credits: number;
  /** The page URL the card was built from (after the API normalised it). A
   * response replayed for an `idempotencyKey` carries origin + path only:
   * the page's query and fragment are never stored. */
  sourceUrl: string;
  /** Unix seconds when the page's 90-day billing window ends: until then
   * the same page with the same content of its own (or none) costs no
   * credit. Equals
   * the request time when no window covers this card, and about a minute
   * from now when `styleProvisional` is set. */
  refreshAfter: number;
  /** Present (`true`) when the site's style was still being analyzed as the
   * card was stored, so `url` may not carry the final style. Call
   * `autoImage` for the same page again after `refreshAfter` with a new (or
   * no) `idempotencyKey`: inside the page's 90-day window that costs nothing
   * and returns the final card. */
  styleProvisional?: true;
}

export interface PublicAutoUrlOptions {
  /** A key the owner marked public (the same id `publicImageUrl` takes). */
  publicKey: string;
  /** Absolute `http(s)://` URL of the page the card is for. */
  url: string;
  template?: string;
  /** Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
}

export interface SignAutoImageUrlOptions {
  keyId: string;
  /** The key's signing secret: raw bytes, or the base64 string the
   * dashboard shows (same encoding the Python SDK's `decode_secret` takes). */
  secret: Uint8Array | string;
  /** Absolute `http(s)://` URL of the page the card is for. */
  url: string;
  template?: string;
  /** Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
}

export interface OgmakeClient {
  renderImage(options: RenderImageOptions): Promise<RenderImageResult>;
  /** Auto mode: POST /v1/images `{auto: true, url, template?}`. ogmake
   * reads the page and returns a hosted card URL. */
  autoImage(options: AutoImageOptions): Promise<AutoImageResult>;
  /** Async single render: 202 now, the outcome POSTed to `webhookUrl`. */
  renderImageAsync(options: RenderImageAsyncOptions): Promise<RenderImageAsyncResult>;
  /** Starts an async batch of up to 500 images (POST /v1/batch, JSON). */
  createBatch(options: CreateBatchOptions): Promise<CreateBatchResult>;
  /** Starts an async batch from CSV text: a header row with `template` plus
   * one column per param (control columns: format, preset, scale, v, bg, font). */
  createBatchCsv(csv: string, options?: { webhookUrl?: string }): Promise<CreateBatchResult>;
  /** Status of a batch with per-item stored URLs or errors. */
  getBatch(batchId: string): Promise<BatchStatusResult>;
  /** The account's webhook delivery log, newest first. */
  listWebhookDeliveries(options?: ListWebhookDeliveriesOptions): Promise<{ deliveries: WebhookDelivery[] }>;
  /** Renders raw `html` (+ optional `css`) to a stored image/PDF. 2 credits. */
  renderHtml(options: RenderHtmlOptions): Promise<RenderHtmlResult>;
  listTemplates(): Promise<ListTemplatesResult>;
  getUsage(): Promise<UsageResult>;
  freeRender(options: FreeRenderOptions): Promise<FreeRenderResult>;
  /** Signs a `/i/:keyId/:sig` URL locally with `signingSecret` — the key
   * never leaves the caller's process. `keyId` identifies which account key
   * signed it (server-side lookup); `signingSecret` is that key's own
   * signing secret (distinct from the Bearer API key). */
  signImageUrl(keyId: string, signingSecret: Uint8Array, options: SignImageUrlOptions): Promise<string>;
  /** Builds a public, unsigned `/p/:keyId/:templateId` URL (D48,
   * apps/api/src/p-route.ts) — the key's owner must have marked it public
   * and allow-listed `templateId`; this is pure URL construction, no
   * crypto, unlike {@link signImageUrl}. */
  publicImageUrl(keyId: string, templateId: string, baseUrl?: string): string;
  /** Checks a page's Open Graph and Twitter card metadata. */
  checkLinkPreview(url: string): Promise<CheckLinkPreviewResult>;
}

function paramsToQuery(params: Record<string, string> | undefined): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    query.set(key, value);
  }
  return query;
}

async function doFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw new OgmakeNetworkError(cause);
  }
  // `redirect: "manual"` on Node/undici and workerd (the SDK's two real
  // runtimes) resolves to the real 3xx status rather than an opaque
  // browser-only status-0 response — never followed, never treated as
  // success. Cancel the (unread, and for a redirect, uninteresting) body
  // before throwing: undici/workerd hold the underlying connection open
  // for an unread-but-not-cancelled body, so a caller that repeatedly hits
  // a redirect (a misconfigured baseUrl, a caller retrying blindly) would
  // otherwise leak sockets/connections one per call.
  if (response.status >= 300 && response.status < 400) {
    await cancelBody(response);
    throw new OgmakeRedirectError(response.status, response.headers.get("location"));
  }
  return response;
}

/** The JSON body fields shared by POST /v1/images and a batch item. */
function imageBody(opts: RenderImageOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { template: opts.template };
  if (opts.params) body.params = opts.params;
  if (opts.format) body.format = opts.format;
  if (opts.preset) body.preset = opts.preset;
  if (opts.scale) body.scale = opts.scale;
  if (opts.v) body.v = opts.v;
  if (opts.bg) body.bg = opts.bg;
  if (opts.font) body.font = opts.font;
  return body;
}

// RFC3986 encoding, identical to packages/core/src/signing.ts and the
// Python SDK's `urllib.parse.quote(v, safe="")`.
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

// Same check as the Python SDK's `_check_page_url`: an absolute http(s) URL
// with a host. The API does the real validation; this catches obvious
// mistakes (a path, a bare host) before a URL is built or a request sent.
const PAGE_URL_RE = /^https?:\/\/[^\s/?#]+/i;

function assertPageUrl(url: string): void {
  if (!PAGE_URL_RE.test(url)) {
    throw new TypeError("@ogmake/sdk: url must be an absolute http(s):// page URL");
  }
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeSecret(secret: Uint8Array | string): Uint8Array {
  if (typeof secret !== "string") return secret;
  if (!BASE64_RE.test(secret)) throw new Error("invalid_signing_secret");
  const binary = atob(secret);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `{base}/p/{publicKey}/auto` — shared by {@link publicAutoUrl} and
 * snippets.ts's `autoSnippet`. */
export function publicAutoBase(publicKey: string, baseUrl: string = DEFAULT_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, "")}/p/${encodeURIComponent(publicKey)}/auto`;
}

/** Public, unsigned auto-mode URL:
 * `{base}/p/{publicKey}/auto?url={page}&template={id}`. Pure string
 * building, safe in the browser (no secret involved). The key's owner must
 * have marked it public. */
export function publicAutoUrl(opts: PublicAutoUrlOptions): string {
  assertPageUrl(opts.url);
  let out = `${publicAutoBase(opts.publicKey, opts.baseUrl)}?url=${rfc3986Encode(opts.url)}`;
  if (opts.template) out += `&template=${rfc3986Encode(opts.template)}`;
  return out;
}

/** Signed auto-mode URL: `{base}/i/{keyId}/{sig}?auto=1&template=…&url=…`,
 * the HMAC-SHA256 computed locally over the canonical query (with `auto`
 * and `url` included), exactly as `signImageUrl` signs a template render.
 *
 * SERVER-SIDE ONLY. Never call this in a browser or ship the signing
 * secret in a client bundle: anyone holding it can mint images billed to
 * your account. Build the URL on the server and send only the URL out. */
export async function signAutoImageUrl(opts: SignAutoImageUrlOptions): Promise<string> {
  assertPageUrl(opts.url);
  const query = new URLSearchParams();
  query.set("auto", "1");
  query.set("url", opts.url);
  if (opts.template) query.set("template", opts.template);
  const canonical = canonicalQuery(query);
  const sig = await signQuery(decodeSecret(opts.secret), canonical);
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/i/${encodeURIComponent(opts.keyId)}/${sig}?${canonical}`;
}

export function createClient(options: CreateClientOptions = {}): OgmakeClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = options.apiKey;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("@ogmake/sdk: no fetch available — pass { fetch } explicitly");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const autoTimeoutMs = options.timeoutMs ?? DEFAULT_AUTO_TIMEOUT_MS;

  function authHeaders(): Record<string, string> {
    if (!apiKey) {
      throw new OgmakeApiError("unauthenticated", 0);
    }
    return { authorization: `Bearer ${apiKey}` };
  }

  /** Authenticated JSON/CSV call whose success body is JSON (2xx). */
  async function authed<T>(
    method: "GET" | "POST",
    path: string,
    contentType?: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    callTimeoutMs: number = timeoutMs,
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...authHeaders(),
      "user-agent": `ogmake-sdk/${OGMAKE_SDK_VERSION}`,
      ...extraHeaders,
    };
    if (contentType) headers["content-type"] = contentType;
    const response = await doFetch(
      fetchImpl,
      `${baseUrl}${path}`,
      { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) },
      callTimeoutMs,
    );
    if (!response.ok) throw await toApiError(response);
    return (await response.json()) as T;
  }

  return {
    async renderImage(opts: RenderImageOptions): Promise<RenderImageResult> {
      const headers = { ...authHeaders(), "content-type": "application/json" };
      const body: Record<string, unknown> = { template: opts.template };
      if (opts.params) body.params = opts.params;
      if (opts.format) body.format = opts.format;
      if (opts.preset) body.preset = opts.preset;
      if (opts.scale) body.scale = opts.scale;
      if (opts.v) body.v = opts.v;
      if (opts.bg) body.bg = opts.bg;
      if (opts.font) body.font = opts.font;

      const response = await doFetch(
        fetchImpl,
        `${baseUrl}/v1/images`,
        {
          method: "POST",
          headers: { ...headers, "user-agent": `ogmake-sdk/${OGMAKE_SDK_VERSION}` },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
      if (!response.ok) throw await toApiError(response);
      return (await response.json()) as RenderImageResult;
    },

    async autoImage(opts: AutoImageOptions): Promise<AutoImageResult> {
      assertPageUrl(opts.url);
      const body: Record<string, unknown> = { auto: true, url: opts.url };
      if (opts.template) body.template = opts.template;
      return authed<AutoImageResult>(
        "POST",
        "/v1/images",
        "application/json",
        body,
        opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : undefined,
        opts.timeoutMs ?? autoTimeoutMs,
      );
    },

    renderImageAsync(opts: RenderImageAsyncOptions): Promise<RenderImageAsyncResult> {
      const { webhookUrl, ...image } = opts;
      return authed<RenderImageAsyncResult>("POST", "/v1/images", "application/json", {
        ...imageBody(image),
        webhook_url: webhookUrl,
      });
    },

    createBatch(opts: CreateBatchOptions): Promise<CreateBatchResult> {
      return authed<CreateBatchResult>("POST", "/v1/batch", "application/json", {
        items: opts.items.map(imageBody),
        ...(opts.webhookUrl ? { webhook_url: opts.webhookUrl } : {}),
      });
    },

    createBatchCsv(csv: string, opts?: { webhookUrl?: string }): Promise<CreateBatchResult> {
      const query = opts?.webhookUrl ? `?webhook_url=${encodeURIComponent(opts.webhookUrl)}` : "";
      return authed<CreateBatchResult>("POST", `/v1/batch${query}`, "text/csv", csv);
    },

    getBatch(batchId: string): Promise<BatchStatusResult> {
      return authed<BatchStatusResult>("GET", `/v1/batch/${encodeURIComponent(batchId)}`);
    },

    listWebhookDeliveries(opts?: ListWebhookDeliveriesOptions): Promise<{ deliveries: WebhookDelivery[] }> {
      const query = new URLSearchParams();
      if (opts?.batchId) query.set("batch_id", opts.batchId);
      if (opts?.limit !== undefined) query.set("limit", String(opts.limit));
      const qs = query.toString();
      return authed<{ deliveries: WebhookDelivery[] }>("GET", `/v1/webhooks/deliveries${qs ? `?${qs}` : ""}`);
    },

    async renderHtml(opts: RenderHtmlOptions): Promise<RenderHtmlResult> {
      const headers = authHeaders();
      const body: Record<string, unknown> = { html: opts.html, width: opts.width, height: opts.height };
      if (opts.css) body.css = opts.css;
      if (opts.format) body.format = opts.format;
      const response = await doFetch(
        fetchImpl,
        `${baseUrl}/v1/images`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", "user-agent": `ogmake-sdk/${OGMAKE_SDK_VERSION}` },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
      if (!response.ok) throw await toApiError(response);
      return (await response.json()) as RenderHtmlResult;
    },

    async listTemplates(): Promise<ListTemplatesResult> {
      const response = await doFetch(
        fetchImpl,
        `${baseUrl}/v1/templates`,
        { method: "GET", headers: { "user-agent": `ogmake-sdk/${OGMAKE_SDK_VERSION}` } },
        timeoutMs,
      );
      if (!response.ok) throw await toApiError(response);
      return (await response.json()) as ListTemplatesResult;
    },

    async getUsage(): Promise<UsageResult> {
      const headers = authHeaders();
      const response = await doFetch(
        fetchImpl,
        `${baseUrl}/v1/usage`,
        { method: "GET", headers: { ...headers, "user-agent": `ogmake-sdk/${OGMAKE_SDK_VERSION}` } },
        timeoutMs,
      );
      if (!response.ok) throw await toApiError(response);
      return (await response.json()) as UsageResult;
    },

    async checkLinkPreview(url: string): Promise<CheckLinkPreviewResult> {
      // /v1/check is public, but accepting a key lets the service associate
      // requests with an account when callers have one configured.
      const response = await doFetch(
        fetchImpl,
        `${baseUrl}/v1/check?url=${encodeURIComponent(url)}`,
        {
          method: "GET",
          headers: {
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            "user-agent": `ogmake-sdk/${OGMAKE_SDK_VERSION}`,
          },
        },
        timeoutMs,
      );
      if (!response.ok) throw await toApiError(response);
      return (await response.json()) as CheckLinkPreviewResult;
    },

    async freeRender(opts: FreeRenderOptions): Promise<FreeRenderResult> {
      const query = new URLSearchParams();
      query.set("title", opts.title);
      if (opts.description) query.set("description", opts.description);
      if (opts.site) query.set("site", opts.site);

      const response = await doFetch(
        fetchImpl,
        `${baseUrl}/v1/free/og?${query.toString()}`,
        { method: "GET", headers: { "user-agent": `ogmake-sdk/${OGMAKE_SDK_VERSION}` } },
        timeoutMs,
      );
      if (!response.ok) throw await toApiError(response);
      // Opus review minor: this response is the actual rendered image
      // bytes (not JSON), so — like ogmake-mcp's own inline-preview fetch
      // (packages/mcp/src/server.ts's defaultFetchImageBytes) — it's
      // validated as a real image response and capped before being
      // buffered into memory, rather than trusted on `response.ok` alone.
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("image/")) {
        await cancelBody(response);
        throw new Error(`ogmake free render returned an unexpected content-type: "${contentType}"`);
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_FREE_RENDER_BYTES) {
        await cancelBody(response);
        throw new Error(`ogmake free render exceeds ${MAX_FREE_RENDER_BYTES} bytes`);
      }
      const bytes = await readCappedBytes(
        response,
        MAX_FREE_RENDER_BYTES,
        `ogmake free render exceeds ${MAX_FREE_RENDER_BYTES} bytes`,
      );
      return { bytes, contentType };
    },

    async signImageUrl(
      keyId: string,
      signingSecret: Uint8Array,
      opts: SignImageUrlOptions,
    ): Promise<string> {
      // Signed GET /i/:keyId/:sig (apps/api/src/i-route.ts) reads the
      // template id from the query string (`template=...`), same as every
      // other control param — the path only ever carries keyId/sig.
      const query = paramsToQuery(opts.params);
      query.set("template", opts.template);
      if (opts.format) query.set("format", opts.format);
      if (opts.preset) query.set("preset", opts.preset);
      if (opts.scale) query.set("scale", opts.scale);
      if (opts.v) query.set("v", opts.v);
      if (opts.bg) query.set("bg", opts.bg);
      if (opts.font) query.set("font", opts.font);

      const canonical = canonicalQuery(query);
      const sig = await signQuery(signingSecret, canonical);
      const base = (opts.baseUrl ?? baseUrl).replace(/\/+$/, "");
      const finalQuery = new URLSearchParams(query);
      finalQuery.set("sig", sig);
      return `${base}/i/${encodeURIComponent(keyId)}/${encodeURIComponent(sig)}?${finalQuery.toString()}`;
    },

    publicImageUrl(keyId: string, templateId: string, overrideBaseUrl?: string): string {
      const base = (overrideBaseUrl ?? baseUrl).replace(/\/+$/, "");
      return `${base}/p/${encodeURIComponent(keyId)}/${encodeURIComponent(templateId)}`;
    },
  };
}
