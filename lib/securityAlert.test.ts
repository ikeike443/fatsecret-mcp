import { describe, it, expect, vi, afterEach } from "vitest";
import { after } from "next/server";
import {
  buildSecurityEvent,
  getClientIp,
  logSecurityEvent,
  reportSecurityFailure,
  scheduleSecurityAlert,
  sendSecurityAlert,
} from "./securityAlert";

// `after()` only works inside a real Next.js request scope; outside of one
// (as in every test here) the real implementation throws. Mock it so we can
// exercise BOTH scheduleSecurityAlert() branches on demand: the default
// implementation below runs the callback synchronously (the "real request
// scope" path), and individual tests can override it with
// `mockImplementationOnce` to throw (the "no request scope" fallback path).
vi.mock("next/server", () => ({
  after: vi.fn((cb: () => void | Promise<void>) => cb()),
}));

describe("getClientIp", () => {
  it("reads the LAST address from x-forwarded-for (the last hop's own view, hardest for a client to spoof)", () => {
    const req = new Request("https://example.com/api/mcp", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("reads the last entry even with 3+ hops in the chain", () => {
    const req = new Request("https://example.com/api/mcp", {
      headers: {
        "x-forwarded-for": "198.51.100.1, 203.0.113.5, 10.0.0.1, 10.0.0.2",
      },
    });
    expect(getClientIp(req)).toBe("10.0.0.2");
  });

  it("falls back to x-real-ip", () => {
    const req = new Request("https://example.com/api/mcp", {
      headers: { "x-real-ip": "203.0.113.9" },
    });
    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("falls back to 'unknown' when neither header is present", () => {
    const req = new Request("https://example.com/api/mcp");
    expect(getClientIp(req)).toBe("unknown");
  });
});

describe("buildSecurityEvent", () => {
  it("includes path/ip/userAgent/time plus any extra fields", () => {
    const req = new Request("https://example.com/api/oauth/token", {
      headers: {
        "x-forwarded-for": "203.0.113.5",
        "user-agent": "test-agent/1.0",
      },
    });
    const evt = buildSecurityEvent(req, "oauth_token_failure", "invalid_client", {
      clientId: "abc",
    });
    expect(evt).toMatchObject({
      event: "oauth_token_failure",
      reason: "invalid_client",
      ip: "203.0.113.5",
      userAgent: "test-agent/1.0",
      path: "/api/oauth/token",
      clientId: "abc",
    });
    expect(typeof evt.time).toBe("string");
  });
});

describe("logSecurityEvent", () => {
  it("writes one line of JSON to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const evt = buildSecurityEvent(new Request("https://example.com/api/mcp"), "e", "r");
    logSecurityEvent(evt);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(spy.mock.calls[0][0] as string)).not.toThrow();
    spy.mockRestore();
  });
});

describe("sendSecurityAlert", () => {
  const originalWebhook = process.env.SECURITY_ALERT_WEBHOOK_URL;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = originalWebhook;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does nothing when SECURITY_ALERT_WEBHOOK_URL is not set", async () => {
    delete process.env.SECURITY_ALERT_WEBHOOK_URL;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await sendSecurityAlert(
      buildSecurityEvent(new Request("https://example.com/api/mcp"), "e", "r")
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs a text payload to the webhook when configured", async () => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = "https://hooks.example.com/webhook";
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const evt = buildSecurityEvent(
      new Request("https://example.com/api/mcp"),
      "mcp_auth_failure",
      "invalid_token"
    );
    await sendSecurityAlert(evt);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/webhook");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain("invalid_token");
  });

  it("never throws when the webhook request fails", async () => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = "https://hooks.example.com/webhook";
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendSecurityAlert(
        buildSecurityEvent(new Request("https://example.com/api/mcp"), "e", "r")
      )
    ).resolves.toBeUndefined();

    // Logs its own delivery-failure line rather than swallowing silently.
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

});

describe("scheduleSecurityAlert", () => {
  const originalWebhook = process.env.SECURITY_ALERT_WEBHOOK_URL;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = originalWebhook;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    // vi.restoreAllMocks() restores spies but the mocked next/server module
    // itself isn't a spy on a real implementation — put its default
    // (call-the-callback) behavior back explicitly so it doesn't leak
    // mockImplementationOnce overrides between tests.
    vi.mocked(after).mockReset();
    vi.mocked(after).mockImplementation(((cb: () => void) => cb()) as typeof after);
  });

  it("prefers after() when a real request scope is available (doesn't fall into the catch branch)", async () => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = "https://hooks.example.com/webhook";
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    global.fetch = fetchSpy as unknown as typeof fetch;

    // The mocked after() (default implementation, set in afterEach above)
    // does not throw, so scheduleSecurityAlert should call it directly
    // rather than falling back to the catch branch below.
    scheduleSecurityAlert(
      buildSecurityEvent(new Request("https://example.com/api/mcp"), "e", "r")
    );

    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith(expect.any(Function));

    // sendSecurityAlert is async; give its microtask a turn to run before
    // asserting it was actually dispatched via the after() callback.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to firing the alert directly when after() has no request scope (e.g. called from a test)", async () => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = "https://hooks.example.com/webhook";
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    global.fetch = fetchSpy as unknown as typeof fetch;

    // Force after() to throw, simulating the real Next.js behavior when
    // called outside an active request scope (e.g. from a plain unit test
    // calling verifyBearerToken()/this module directly).
    vi.mocked(after).mockImplementationOnce(() => {
      throw new Error("`after` used outside of a request scope");
    });

    scheduleSecurityAlert(
      buildSecurityEvent(new Request("https://example.com/api/mcp"), "e", "r")
    );

    // sendSecurityAlert is async and not awaited by the caller by design;
    // give its microtask a turn to run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never throws, even with no webhook configured", () => {
    delete process.env.SECURITY_ALERT_WEBHOOK_URL;
    expect(() =>
      scheduleSecurityAlert(
        buildSecurityEvent(new Request("https://example.com/api/mcp"), "e", "r")
      )
    ).not.toThrow();
  });
});

describe("sendSecurityAlert message content", () => {
  const originalWebhook = process.env.SECURITY_ALERT_WEBHOOK_URL;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = originalWebhook;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("never includes the actual bearer token / secret value in the alert text", async () => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = "https://hooks.example.com/webhook";
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const evt = buildSecurityEvent(
      new Request("https://example.com/api/mcp"),
      "mcp_auth_failure",
      "invalid_token"
    );
    await sendSecurityAlert(evt);

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    // Guard against a future edit accidentally spreading the presented
    // token/secret into the event's extra fields.
    expect(body.text).not.toMatch(/correct-token|Bearer /i);
  });

  it("includes extra context fields (e.g. clientId) in the posted webhook text", async () => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = "https://hooks.example.com/webhook";
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const evt = buildSecurityEvent(
      new Request("https://example.com/api/oauth/token"),
      "oauth_token_failure",
      "unauthorized_client",
      { clientId: "abc" }
    );
    await sendSecurityAlert(evt);

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain("abc");
  });
});

describe("reportSecurityFailure", () => {
  const originalWebhook = process.env.SECURITY_ALERT_WEBHOOK_URL;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = originalWebhook;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.mocked(after).mockReset();
    vi.mocked(after).mockImplementation(((cb: () => void) => cb()) as typeof after);
  });

  it("logs to console.error and schedules a webhook alert with the given event/reason/extra", async () => {
    delete process.env.SECURITY_ALERT_WEBHOOK_URL;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    reportSecurityFailure(
      new Request("https://example.com/api/oauth/authorize"),
      "oauth_authorize_failure",
      "unauthorized_client",
      { clientId: "guessed-id" }
    );

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      event: "oauth_authorize_failure",
      reason: "unauthorized_client",
      clientId: "guessed-id",
    });
  });
});
