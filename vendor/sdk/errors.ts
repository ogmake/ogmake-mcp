// @ogmake/sdk — typed errors.
//
// The API always answers a failure with JSON `{ error: <code>, detail?: [...] }`
// (apps/api/src/error-detail.ts). `OgmakeApiError` carries that code through
// so a caller can `if (err instanceof OgmakeApiError && err.code === "quota_exceeded")`
// instead of string-matching a message. A response that ISN'T JSON, or whose
// JSON has no `error` string field, still becomes an `OgmakeApiError` with
// `code: "unknown_error"` — never a raw parse exception bubbling up.
export interface OgmakeErrorDetail {
  field: string;
  message: string;
}

export class OgmakeApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: OgmakeErrorDetail[] | undefined;

  constructor(code: string, status: number, detail?: OgmakeErrorDetail[]) {
    super(`ogmake API error: ${code} (HTTP ${status})`);
    this.name = "OgmakeApiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** Thrown for a network-level failure (fetch rejected) — never carries a
 * status code, since none was ever received. */
export class OgmakeNetworkError extends Error {
  constructor(cause: unknown) {
    super(`ogmake network error: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "OgmakeNetworkError";
    this.cause = cause;
  }
}

/** Thrown when the API responds with a redirect. The SDK never follows a
 * redirect on an authenticated request (a Bearer key must never be replayed
 * against a different origin), so this is always an error, not a retry. */
export class OgmakeRedirectError extends Error {
  readonly status: number;
  readonly location: string | null;

  constructor(status: number, location: string | null) {
    super(`ogmake API returned a redirect (HTTP ${status}); the SDK never follows redirects`);
    this.name = "OgmakeRedirectError";
    this.status = status;
    this.location = location;
  }
}

async function parseErrorBody(response: Response): Promise<{ code: string; detail?: OgmakeErrorDetail[] }> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { code: "unknown_error" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { code: "unknown_error" };
  }
  const body = parsed as Record<string, unknown>;
  const code = typeof body.error === "string" && body.error.length > 0 ? body.error : "unknown_error";
  const detail = Array.isArray(body.detail)
    ? (body.detail.filter(
        (d): d is OgmakeErrorDetail =>
          typeof d === "object" &&
          d !== null &&
          typeof (d as Record<string, unknown>).field === "string" &&
          typeof (d as Record<string, unknown>).message === "string",
      ) as OgmakeErrorDetail[])
    : undefined;
  return detail && detail.length > 0 ? { code, detail } : { code };
}

/** Builds an `OgmakeApiError` from a non-ok `Response`. */
export async function toApiError(response: Response): Promise<OgmakeApiError> {
  const { code, detail } = await parseErrorBody(response);
  return new OgmakeApiError(code, response.status, detail);
}
