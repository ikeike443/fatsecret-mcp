import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProxyAgent } from "undici";
import {
  getAppAccessToken,
  fatsecretAppRequest,
  _resetAppAccessTokenCacheForTests,
  _resetProxyDispatcherForTests,
} from "./appAuth";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.FATSECRET_CLIENT_ID = "test-client-id";
  process.env.FATSECRET_CLIENT_SECRET = "test-client-secret";
  delete process.env.FIXIE_URL;
  _resetAppAccessTokenCacheForTests();
  _resetProxyDispatcherForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

function tokenResponse(overrides: Partial<{ access_token: string; expires_in: number }> = {}) {
  return new Response(
    JSON.stringify({
      access_token: overrides.access_token ?? "app-token-1",
      token_type: "Bearer",
      expires_in: overrides.expires_in ?? 86400,
      scope: "basic",
    }),
    { status: 200 }
  );
}

describe("getAppAccessToken", () => {
  it("requests a token with Basic auth + client_credentials, and returns it", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://oauth.fatsecret.com/connect/token");
      expect(init.method).toBe("POST");
      const expectedBasic = Buffer.from("test-client-id:test-client-secret").toString("base64");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${expectedBasic}`);
      const body = new URLSearchParams(init.body as string);
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("scope")).toBe("basic");
      return tokenResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await getAppAccessToken();
    expect(token).toBe("app-token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches the token across calls instead of re-fetching", async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    vi.stubGlobal("fetch", fetchMock);

    await getAppAccessToken();
    await getAppAccessToken();
    await getAppAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes once the cached token has expired", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse({ access_token: "app-token-1", expires_in: 60 }))
        .mockResolvedValueOnce(tokenResponse({ access_token: "app-token-2", expires_in: 60 }));
      vi.stubGlobal("fetch", fetchMock);

      const first = await getAppAccessToken();
      expect(first).toBe("app-token-1");

      vi.advanceTimersByTime(120_000); // past the 60s expiry + safety margin
      const second = await getAppAccessToken();
      expect(second).toBe("app-token-2");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a separate cache entry per requested scope", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(init.body as string);
      return tokenResponse({ access_token: `token-for-${body.get("scope")}` });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getAppAccessToken("basic")).toBe("token-for-basic");
    expect(await getAppAccessToken("basic barcode")).toBe("token-for-basic barcode");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when FATSECRET_CLIENT_ID/SECRET are not set", async () => {
    delete process.env.FATSECRET_CLIENT_ID;
    delete process.env.FATSECRET_CLIENT_SECRET;
    await expect(getAppAccessToken()).rejects.toThrow(/FATSECRET_CLIENT_ID/);
  });

  it("surfaces a non-2xx token response as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_client", { status: 401 }))
    );
    await expect(getAppAccessToken()).rejects.toThrow(/401/);
  });
});

describe("fatsecretAppRequest", () => {
  it("POSTs method/format=json with a Bearer token and returns the parsed body", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://oauth.fatsecret.com/connect/token") return tokenResponse();
      expect(url).toBe("https://platform.fatsecret.com/rest/server.api");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer app-token-1");
      const body = new URLSearchParams(init.body as string);
      expect(body.get("method")).toBe("foods.search");
      expect(body.get("format")).toBe("json");
      expect(body.get("search_expression")).toBe("apple");
      return new Response(JSON.stringify({ foods: { food: [] } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fatsecretAppRequest("foods.search", { search_expression: "apple" });
    expect(result).toEqual({ foods: { food: [] } });
  });

  it("surfaces a FatSecret method-level error even though the HTTP status is 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://oauth.fatsecret.com/connect/token") return tokenResponse();
        return new Response(JSON.stringify({ error: { code: 106, message: "Invalid food_id" } }), {
          status: 200,
        });
      })
    );

    await expect(fatsecretAppRequest("food.get", { food_id: "0" })).rejects.toThrow(
      /Invalid food_id/
    );
  });

  it("throws on a non-JSON response instead of returning garbage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://oauth.fatsecret.com/connect/token") return tokenResponse();
        return new Response("<html>not json</html>", { status: 200 });
      })
    );

    await expect(fatsecretAppRequest("foods.search", {})).rejects.toThrow(/non-JSON/);
  });
});

describe("FIXIE_URL proxying", () => {
  // Regression coverage for a real finding: FatSecret's IP allowlist check
  // is NOT limited to the token endpoint — a real Vercel deployment (no
  // fixed outbound IP) was rejected with error code 21 ("Invalid IP
  // address detected") on the *food-search* API call itself, using a
  // validly-issued token. So both requests need to go through a fixed-IP
  // proxy when one is configured, not just the token request.
  it("does not attach a dispatcher to either request when FIXIE_URL is unset", async () => {
    const capturedInits: (RequestInit & { dispatcher?: unknown })[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit & { dispatcher?: unknown }) => {
      capturedInits.push(init);
      if (url === "https://oauth.fatsecret.com/connect/token") return tokenResponse();
      return new Response(JSON.stringify({ foods: { food: [] } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fatsecretAppRequest("foods.search", { search_expression: "apple" });

    expect(capturedInits).toHaveLength(2);
    for (const init of capturedInits) {
      // Not just `expect(init.dispatcher).toBeUndefined()` — that would pass
      // identically whether `dispatcher` is absent or present-but-undefined,
      // and the latter is exactly the regression this guards against (some
      // dispatcher-consuming HTTP clients treat an explicitly-present
      // `undefined` differently from a missing key).
      expect("dispatcher" in init).toBe(false);
    }
  });

  it("attaches a ProxyAgent dispatcher to both the token request and the API request when FIXIE_URL is set", async () => {
    process.env.FIXIE_URL = "http://fixie:secret@fixie.example.com:12345";
    const capturedInits: (RequestInit & { dispatcher?: unknown })[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit & { dispatcher?: unknown }) => {
      capturedInits.push(init);
      if (url === "https://oauth.fatsecret.com/connect/token") return tokenResponse();
      return new Response(JSON.stringify({ foods: { food: [] } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fatsecretAppRequest("foods.search", { search_expression: "apple" });

    expect(capturedInits).toHaveLength(2);
    const dispatchers = capturedInits.map((init) => init.dispatcher);
    expect(dispatchers[0]).toBeInstanceOf(ProxyAgent);
    expect(dispatchers[1]).toBeInstanceOf(ProxyAgent);
    // Reused, not rebuilt per request — see proxyDispatcher()'s caching.
    expect(dispatchers[0]).toBe(dispatchers[1]);
  });

  it("rebuilds the dispatcher if FIXIE_URL changes between calls", async () => {
    process.env.FIXIE_URL = "http://fixie:secret@fixie.example.com:12345";
    const capturedInits: (RequestInit & { dispatcher?: unknown })[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit & { dispatcher?: unknown }) => {
      expect(url).toBe("https://oauth.fatsecret.com/connect/token");
      capturedInits.push(init);
      return tokenResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    await getAppAccessToken();
    const firstDispatcher = capturedInits[0].dispatcher;

    process.env.FIXIE_URL = "http://fixie:secret@fixie-2.example.com:12345";
    _resetAppAccessTokenCacheForTests(); // force a second token fetch
    await getAppAccessToken();
    const secondDispatcher = capturedInits[1].dispatcher;

    expect(firstDispatcher).toBeInstanceOf(ProxyAgent);
    expect(secondDispatcher).toBeInstanceOf(ProxyAgent);
    expect(firstDispatcher).not.toBe(secondDispatcher);
  });
});
