// @ogmake/core — request-signing helpers (WebCrypto only: Node 20 + workerd).
// Open question (a): `debug` is excluded from the canonical query so the same
// signed URL keeps working with `?debug=1` appended.

const CANONICAL_EXCLUDED_KEYS = new Set(["sig", "debug"]);

// RFC3986 encoding: encodeURIComponent leaves !'()* unescaped; escape them too.
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Builds the canonical query string used for signing/verification:
 * - drops `sig` and `debug`
 * - rejects duplicate keys (throws — caller maps to 400 invalid_input)
 * - sorts entries by key codepoint
 * - RFC3986-encodes both key and value, joined as `k=v` pairs with `&`
 */
export function canonicalQuery(params: URLSearchParams): string {
  const seen = new Set<string>();
  const entries: Array<[string, string]> = [];
  for (const [key, value] of params.entries()) {
    if (CANONICAL_EXCLUDED_KEYS.has(key)) continue;
    if (seen.has(key)) {
      throw new Error(`duplicate_query_key: ${key}`);
    }
    seen.add(key);
    entries.push([key, value]);
  }
  // The `=== 0` (equal-key) branch is unreachable: the duplicate-key check
  // above guarantees every key in `entries` is distinct, so the comparator
  // is never invoked with a === b.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : /* v8 ignore next */ 0));
  return entries
    .map(([key, value]) => `${rfc3986Encode(key)}=${rfc3986Encode(value)}`)
    .join("&");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLength));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Signs the canonical query string, returning a base64url HMAC-SHA256. */
export async function signQuery(secret: Uint8Array, canonical: string): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
  return base64UrlEncode(new Uint8Array(mac));
}

/**
 * Constant-time byte comparison (XOR-accumulate loop, no `timingSafeEqual`,
 * so this runs unchanged on Node 20 and workerd). Length mismatch
 * short-circuits to false before the loop runs (equal-length inputs only
 * reach the loop). Shared by {@link verifySignature} (WP0) and
 * `verifyPaddleSignature` (WP4 step 32, `packages/core/src/paddle.ts`).
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/**
 * Verifies `sig` against the canonical query, recomputing the HMAC and
 * comparing bytes via {@link timingSafeEqualBytes}.
 */
export async function verifySignature(
  secret: Uint8Array,
  canonical: string,
  sig: string,
): Promise<boolean> {
  let provided: Uint8Array;
  try {
    provided = base64UrlDecode(sig);
  } catch {
    return false;
  }
  const expected = base64UrlDecode(await signQuery(secret, canonical));
  return timingSafeEqualBytes(provided, expected);
}

/** Generates a fresh 32-byte signing secret. */
export function generateSigningSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function aesGcmKey(kek: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(kek), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Wraps a signing secret with the KEK (AES-256-GCM). Blob layout:
 * base64url(iv[12] ‖ ciphertext ‖ tag).
 */
export async function wrapSecret(secret: Uint8Array, kek: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesGcmKey(kek);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(secret));
  const blob = new Uint8Array(iv.length + ct.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(ct), iv.length);
  return base64UrlEncode(blob);
}

/** Reverses {@link wrapSecret}; throws if the KEK is wrong (GCM tag fails). */
export async function unwrapSecret(blob: string, kek: Uint8Array): Promise<Uint8Array> {
  const bytes = base64UrlDecode(blob);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const key = await aesGcmKey(kek);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(pt);
}
