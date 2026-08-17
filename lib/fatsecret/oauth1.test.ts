import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  percentEncode,
  buildSignatureBaseString,
  computeOAuth1Signature,
  signOAuth1Request,
  fatsecretDelegatedRequest,
  API_BASE,
} from "./oauth1";

describe("percentEncode", () => {
  it("escapes the RFC 3986 reserved characters encodeURIComponent leaves alone", () => {
    expect(percentEncode("!'()*")).toBe("%21%27%28%29%2A");
  });

  it("leaves unreserved characters untouched", () => {
    expect(percentEncode("abcABC123-._~")).toBe("abcABC123-._~");
  });
});

describe("buildSignatureBaseString", () => {
  it("uppercases the method, sorts params, and percent-encodes each component", () => {
    const base = buildSignatureBaseString("get", "https://example.com/api", {
      b: "2",
      a: "1",
    });
    expect(base).toBe(
      "GET&https%3A%2F%2Fexample.com%2Fapi&a%3D1%26b%3D2"
    );
  });
});

describe("computeOAuth1Signature", () => {
  // Independently reimplements HMAC-SHA1 signing (not by calling into
  // oauth1.ts) to cross-check computeOAuth1Signature's output, rather than
  // hardcoding a signature value that would just be trusting the same code
  // under test.
  function referenceSignature(
    method: string,
    url: string,
    params: Record<string, string>,
    consumerSecret: string,
    tokenSecret = ""
  ): string {
    const normalized = Object.keys(params)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join("&");
    const baseString = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(normalized)].join("&");
    const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
    return createHmac("sha1", signingKey).update(baseString).digest("base64");
  }

  it("matches an independently computed HMAC-SHA1 signature (2-legged, no token secret)", () => {
    const params = { oauth_nonce: "abc", oauth_timestamp: "123", search_expression: "coffee" };
    const expected = referenceSignature("GET", API_BASE, params, "my-consumer-secret");
    expect(computeOAuth1Signature("GET", API_BASE, params, "my-consumer-secret")).toBe(expected);
  });

  it("matches an independently computed HMAC-SHA1 signature (3-legged, with token secret)", () => {
    const params = { oauth_token: "tok", date: "20000" };
    const expected = referenceSignature("POST", API_BASE, params, "consumer-secret", "token-secret");
    expect(computeOAuth1Signature("POST", API_BASE, params, "consumer-secret", "token-secret")).toBe(expected);
  });

  it("changes when any parameter changes", () => {
    const base = { oauth_nonce: "abc" };
    const sig1 = computeOAuth1Signature("GET", API_BASE, base, "secret");
    const sig2 = computeOAuth1Signature("GET", API_BASE, { ...base, extra: "1" }, "secret");
    expect(sig1).not.toBe(sig2);
  });
});

describe("signOAuth1Request", () => {
  it("includes all required oauth_* fields plus the signature, without a token when none is given", () => {
    const signed = signOAuth1Request(
      "POST",
      API_BASE,
      { method: "foods.search" },
      { consumerKey: "ck", consumerSecret: "cs" }
    );
    expect(signed.oauth_consumer_key).toBe("ck");
    expect(signed.oauth_signature_method).toBe("HMAC-SHA1");
    expect(signed.oauth_version).toBe("1.0");
    expect(signed.oauth_token).toBeUndefined();
    expect(signed.oauth_signature).toBeTruthy();
    expect(signed.method).toBe("foods.search");
  });

  it("includes oauth_token when credentials carry a token", () => {
    const signed = signOAuth1Request(
      "POST",
      API_BASE,
      {},
      { consumerKey: "ck", consumerSecret: "cs", token: "tok", tokenSecret: "ts" }
    );
    expect(signed.oauth_token).toBe("tok");
  });
});

describe("fatsecretDelegatedRequest", () => {
  const ORIGINAL_ENV = { ...process.env };

  function setDelegatedEnv() {
    process.env.FATSECRET_CONSUMER_KEY = "ck";
    process.env.FATSECRET_CONSUMER_SECRET = "cs";
    process.env.FATSECRET_ACCESS_TOKEN = "tok";
    process.env.FATSECRET_ACCESS_TOKEN_SECRET = "ts";
  }

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws a clear error when consumer credentials are missing", async () => {
    delete process.env.FATSECRET_CONSUMER_KEY;
    delete process.env.FATSECRET_CONSUMER_SECRET;
    await expect(fatsecretDelegatedRequest("profile.get", {})).rejects.toThrow(
      /FATSECRET_CONSUMER_KEY/
    );
  });

  it("throws a clear error when the access token is missing", async () => {
    process.env.FATSECRET_CONSUMER_KEY = "ck";
    process.env.FATSECRET_CONSUMER_SECRET = "cs";
    delete process.env.FATSECRET_ACCESS_TOKEN;
    delete process.env.FATSECRET_ACCESS_TOKEN_SECRET;
    await expect(fatsecretDelegatedRequest("profile.get", {})).rejects.toThrow(
      /fatsecret:oauth-setup/
    );
  });

  it("POSTs a signed, format=json request and returns the parsed body", async () => {
    setDelegatedEnv();

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(API_BASE);
      expect(init.method).toBe("POST");
      const body = new URLSearchParams(init.body as string);
      expect(body.get("method")).toBe("profile.get");
      expect(body.get("format")).toBe("json");
      expect(body.get("oauth_consumer_key")).toBe("ck");
      expect(body.get("oauth_token")).toBe("tok");
      expect(body.get("oauth_signature")).toBeTruthy();
      return new Response(JSON.stringify({ profile: { last_weight_kg: "70.0" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fatsecretDelegatedRequest("profile.get", {});
    expect(result).toEqual({ profile: { last_weight_kg: "70.0" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a FatSecret method-level error even though the HTTP status is 200", async () => {
    setDelegatedEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 2, message: "Missing required parameter" } }), {
          status: 200,
        })
      )
    );

    await expect(fatsecretDelegatedRequest("profile.get", {})).rejects.toThrow(
      /Missing required parameter/
    );
  });
});
