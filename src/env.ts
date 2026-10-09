// packages/mcp/src/env.ts — reads the handful of env vars ogmake-mcp
// accepts, plus the shared param caps every tool enforces before calling
// @ogmake/sdk. Nothing here ever logs, echoes, or otherwise surfaces a
// secret value — see server.test.ts's secret-leak sweep, which asserts
// that across every tool's success/error/thrown-exception path.

/** Bearer API key. Present -> render_image/get_usage use the authenticated
 * API; absent -> render_image falls back to the free/watermarked endpoint
 * and get_usage refuses locally (no network call). */
export const OGMAKE_API_KEY = "OGMAKE_API_KEY";
/** API origin override — production default lives in @ogmake/sdk
 * (DEFAULT_BASE_URL). Only ever set for local development/e2e against a
 * `wrangler dev` instance. */
export const OGMAKE_BASE_URL = "OGMAKE_BASE_URL";
/** base64url-encoded 32-byte signing secret for build_image_url's local
 * signing path. Must be paired with OGMAKE_SIGNING_KEY_ID. */
export const OGMAKE_SIGNING_SECRET = "OGMAKE_SIGNING_SECRET";
/** The account API key's id the signing secret belongs to — the `:keyId`
 * segment of a signed `/i/:keyId/:sig` URL. */
export const OGMAKE_SIGNING_KEY_ID = "OGMAKE_SIGNING_KEY_ID";
/** The account API key's id to build an unsigned `/p/:keyId/:template`
 * URL under, when no signing secret is configured. */
export const OGMAKE_PUBLIC_KEY_ID = "OGMAKE_PUBLIC_KEY_ID";

export interface OgmakeEnv {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  signingSecretB64Url: string | undefined;
  signingKeyId: string | undefined;
  publicKeyId: string | undefined;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): OgmakeEnv {
  const baseUrl = nonEmpty(source[OGMAKE_BASE_URL]);
  if (baseUrl !== undefined) assertAllowedBaseUrl(baseUrl);
  const signingSecretB64Url = nonEmpty(source[OGMAKE_SIGNING_SECRET]);
  if (signingSecretB64Url !== undefined) assertSigningSecretLength(signingSecretB64Url);
  return {
    apiKey: nonEmpty(source[OGMAKE_API_KEY]),
    baseUrl,
    signingSecretB64Url,
    signingKeyId: nonEmpty(source[OGMAKE_SIGNING_KEY_ID]),
    publicKeyId: nonEmpty(source[OGMAKE_PUBLIC_KEY_ID]),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/** Restricts OGMAKE_BASE_URL to the real production origin or a local dev
 * server — a stdio MCP server run with a locally-controlled env has no
 * other gate on where an authenticated client sends the caller's API key,
 * so an unconstrained override is an exfiltration vector (a malicious or
 * mistaken value could point the SDK at an attacker-controlled origin and
 * have it hand over the bearer key on every call). Throws a plain `Error`
 * that names none of the env var's actual value — only that it was
 * rejected — since the value itself could embed credentials
 * (`https://user:pass@evil.example`) that would leak into logs otherwise. */
function assertAllowedBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${OGMAKE_BASE_URL} is not a valid URL`);
  }
  const isProd = url.protocol === "https:" && url.hostname === "ogmake.com";
  const isLocal =
    (url.protocol === "https:" || url.protocol === "http:") && LOCAL_HOSTNAMES.has(url.hostname);
  if (!isProd && !isLocal) {
    throw new Error(
      `${OGMAKE_BASE_URL} must be https://ogmake.com or http(s)://localhost|127.0.0.1[:port]`,
    );
  }
}

/** Decodes a base64url string into raw bytes (the signing secret's wire
 * format) without pulling in a DOM/Workers-only `atob`. Throws (a plain
 * `Error`, never one that echoes `value`) on malformed input. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function base64UrlDecode(value: string): Uint8Array {
  // Node's `Buffer.from(..., "base64")` silently SKIPS characters outside
  // the base64 alphabet rather than throwing — a strict allowlist check is
  // required first, or garbage input (e.g. a copy-paste mistake) would
  // silently decode into wrong-but-plausible-looking bytes instead of
  // failing loudly.
  if (!BASE64URL_RE.test(value)) {
    throw new Error("OGMAKE_SIGNING_SECRET is not valid base64url");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const buf = Buffer.from(padded + "=".repeat(padLength), "base64");
  if (buf.length === 0) {
    throw new Error("OGMAKE_SIGNING_SECRET is not valid base64url");
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const SIGNING_SECRET_BYTES = 32;

/** Rejects a misconfigured OGMAKE_SIGNING_SECRET at startup rather than
 * only when build_image_url is first called — the SDK's signing scheme
 * requires exactly 32 raw bytes (see @ogmake/sdk's HMAC signing), and a
 * short or padded value would sign every URL with a weaker or
 * differently-shaped key without any visible error until a signature
 * fails to verify server-side. Throws a plain `Error` that names neither
 * the raw value nor its decoded bytes. */
function assertSigningSecretLength(value: string): void {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(value);
  } catch {
    throw new Error(`${OGMAKE_SIGNING_SECRET} is not valid base64url`);
  }
  if (bytes.length !== SIGNING_SECRET_BYTES) {
    throw new Error(`${OGMAKE_SIGNING_SECRET} must decode to exactly ${SIGNING_SECRET_BYTES} bytes`);
  }
}

// Param caps (mechanical, applied before any network call — the server has
// its own authoritative limits, these just stop a pathological MCP call
// from building an oversized request).
export const MAX_TEMPLATE_ID_LENGTH = 200;
export const MAX_PARAM_KEYS = 20;
export const MAX_PARAM_VALUE_LENGTH = 2000;
export const MAX_TITLE_LENGTH = 300;
export const MAX_DESCRIPTION_LENGTH = 200;
export const MAX_SITE_LENGTH = 40;
export const MAX_IMAGE_URL_LENGTH = 2000;
/** `v` (cache-busting version tag) and `bg` (background color/param) are
 * free-text query params passed straight through to the render/signing
 * URL — capped like every other model-supplied string above rather than
 * left unbounded. */
export const MAX_V_LENGTH = 200;
export const MAX_BG_LENGTH = 200;

/** `params` keys the API/signing scheme reserves for itself (
 * apps/api/src/i-route.ts: `sig` is the HMAC signature itself, `debug` a
 * server-only diagnostic switch) — never legitimate template params. A
 * model passing one of these inside `params` is either confused about the
 * shape of the call or trying to smuggle a control param (fabricate
 * `sig`, flip `debug`) in through the one field the tool doesn't
 * otherwise validate the keys of. Rejected outright rather than silently
 * dropped, so the caller sees why nothing happened instead of a
 * silently-ignored param. */
export const RESERVED_PARAM_KEYS = new Set(["sig", "debug"]);
