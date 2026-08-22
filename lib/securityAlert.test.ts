import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildSecurityEvent,
  getClientIp,
  logSecurityEvent,
  scheduleSecurityAlert,
  sendSecurityAlert,
} from "./securityAlert";

describe("getClientIp", () => {
  it("reads the first address from x-forwarded-for", () => {
    const req = new Request("https://example.com/api/mcp", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(getClientIp(req)).toBe("203.0.113.5");
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
  });

  it("falls back to firing the alert directly when after() has no request scope (e.g. called from a test)", async () => {
    process.env.SECURITY_ALERT_WEBHOOK_URL = "https://hooks.example.com/webhook";
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    global.fetch = fetchSpy as unknown as typeof fetch;

    // Calling this directly (not from inside a real Next.js request
    // handler) is exactly the situation after() cannot support — this
    // exercises the catch-and-fall-back branch, not the after() branch.
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
});
