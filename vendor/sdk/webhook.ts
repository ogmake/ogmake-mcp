// @ogmake/sdk — webhook signature verification for receivers.
//
// ogmake signs every webhook with `X-Ogmake-Signature: t=<unix seconds>,v1=<hex>`
// where v1 = HMAC-SHA256(key, `${t}.${rawBody}`) and `key` is the raw bytes of
// the base64-decoded signing secret of the API key that submitted the job
// (apps/api/src/webhook.ts, and the OpenAPI description of POST /v1/batch).
// WebCrypto only, so this runs on Node 20+, Workers, Deno and Bun.

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface VerifyWebhookOptions {
  /** The key's signing secret exactly as shown at creation (base64). */
  signingSecretBase64: string;
  /** The `X-Ogmake-Signature` header value. */
  signatureHeader: string;
  /** The RAW request body text, byte for byte. */
  rawBody: string;
  /** Reject a `t` further than this from now. Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Test seam: current unix seconds. */
  nowSeconds?: number;
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True only for a well-formed header whose timestamp is within tolerance and
 * whose `v1` matches the body. Never throws on bad input — a malformed header
 * or secret is simply not valid. */
export async function verifyWebhookSignature(opts: VerifyWebhookOptions): Promise<boolean> {
  const parts = new Map(opts.signatureHeader.split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !/^\d+$/.test(t) || !v1) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > (opts.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS)) return false;
  let expected: string;
  try {
    const key = await crypto.subtle.importKey("raw", base64ToBytes(opts.signingSecretBase64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${opts.rawBody}`));
    expected = hexOf(new Uint8Array(mac));
  } catch {
    return false;
  }
  return timingSafeEqual(expected, v1);
}
