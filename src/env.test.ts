import { describe, expect, it } from "vitest";
import { base64UrlDecode, readEnv } from "./env";

const VALID_SIGNING_SECRET_B64URL = Buffer.alloc(32, 7).toString("base64url");

describe("readEnv", () => {
  it("reads all five vars when set", () => {
    const env = readEnv({
      OGMAKE_API_KEY: "og_live_x",
      OGMAKE_BASE_URL: "https://ogmake.com",
      OGMAKE_SIGNING_SECRET: VALID_SIGNING_SECRET_B64URL,
      OGMAKE_SIGNING_KEY_ID: "key_1",
      OGMAKE_PUBLIC_KEY_ID: "key_2",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({
      apiKey: "og_live_x",
      baseUrl: "https://ogmake.com",
      signingSecretB64Url: VALID_SIGNING_SECRET_B64URL,
      signingKeyId: "key_1",
      publicKeyId: "key_2",
    });
  });

  it("accepts http://localhost:<port> and http(s)://127.0.0.1 for OGMAKE_BASE_URL", () => {
    expect(readEnv({ OGMAKE_BASE_URL: "http://localhost:8787" } as NodeJS.ProcessEnv).baseUrl).toBe(
      "http://localhost:8787",
    );
    expect(readEnv({ OGMAKE_BASE_URL: "https://127.0.0.1:8787" } as NodeJS.ProcessEnv).baseUrl).toBe(
      "https://127.0.0.1:8787",
    );
  });

  it("rejects an OGMAKE_BASE_URL outside the allowlist without echoing the value", () => {
    expect(() => readEnv({ OGMAKE_BASE_URL: "https://evil.example" } as NodeJS.ProcessEnv)).toThrow(
      /OGMAKE_BASE_URL must be https:\/\/ogmake\.com/,
    );
    try {
      readEnv({ OGMAKE_BASE_URL: "https://evil.example" } as NodeJS.ProcessEnv);
    } catch (err) {
      expect((err as Error).message).not.toContain("evil.example");
    }
  });

  it("rejects a malformed OGMAKE_BASE_URL", () => {
    expect(() => readEnv({ OGMAKE_BASE_URL: "not a url" } as NodeJS.ProcessEnv)).toThrow(
      /OGMAKE_BASE_URL is not a valid URL/,
    );
  });

  it("rejects OGMAKE_SIGNING_SECRET that isn't valid base64url", () => {
    expect(() =>
      readEnv({ OGMAKE_SIGNING_SECRET: "!!!not-base64!!!" } as NodeJS.ProcessEnv),
    ).toThrow(/OGMAKE_SIGNING_SECRET is not valid base64url/);
  });

  it("rejects OGMAKE_SIGNING_SECRET that doesn't decode to exactly 32 bytes, without echoing it", () => {
    const shortSecret = Buffer.alloc(16, 1).toString("base64url");
    expect(() => readEnv({ OGMAKE_SIGNING_SECRET: shortSecret } as NodeJS.ProcessEnv)).toThrow(
      /OGMAKE_SIGNING_SECRET must decode to exactly 32 bytes/,
    );
    try {
      readEnv({ OGMAKE_SIGNING_SECRET: shortSecret } as NodeJS.ProcessEnv);
    } catch (err) {
      expect((err as Error).message).not.toContain(shortSecret);
    }
  });

  it("treats missing and empty-string vars the same (undefined)", () => {
    const env = readEnv({ OGMAKE_API_KEY: "" } as NodeJS.ProcessEnv);
    expect(env.apiKey).toBeUndefined();
    expect(env.baseUrl).toBeUndefined();
    expect(env.signingSecretB64Url).toBeUndefined();
    expect(env.signingKeyId).toBeUndefined();
    expect(env.publicKeyId).toBeUndefined();
  });

  it("defaults to process.env when no source is passed", () => {
    const prior = process.env.OGMAKE_API_KEY;
    process.env.OGMAKE_API_KEY = "og_live_from_process_env";
    try {
      expect(readEnv().apiKey).toBe("og_live_from_process_env");
    } finally {
      if (prior === undefined) delete process.env.OGMAKE_API_KEY;
      else process.env.OGMAKE_API_KEY = prior;
    }
  });
});

describe("base64UrlDecode", () => {
  it("round-trips bytes encoded by base64url (no padding, -/_ substitution)", () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const b64url = Buffer.from(original).toString("base64url");
    const decoded = base64UrlDecode(b64url);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("throws (without echoing the input) on empty input", () => {
    expect(() => base64UrlDecode("")).toThrow(/not valid base64url/);
  });

  it("throws on input containing characters outside the base64url alphabet", () => {
    expect(() => base64UrlDecode("!!!not-base64!!!")).toThrow(/not valid base64url/);
  });

  it("throws on a single-character input that decodes to zero bytes", () => {
    expect(() => base64UrlDecode("A")).toThrow(/not valid base64url/);
  });
});
