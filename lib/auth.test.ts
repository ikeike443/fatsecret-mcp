import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyBearerToken } from "./auth";

describe("verifyBearerToken", () => {
  const originalToken = process.env.MCP_BEARER_TOKEN;
  const originalWebhook = process.env.SECURITY_ALERT_WEBHOOK_URL;
  const dummyRequest = new Request("https://example.com/api/mcp");

  beforeEach(() => {
    process.env.MCP_BEARER_TOKEN = "correct-token-1234567890";
    // Keep alerting off by default in tests unless a test opts in — avoids
    // an accidental real network call if this ever ran outside CI's mocked
    // environment.
    delete process.env.SECURITY_ALERT_WEBHOOK_URL;
  });

  afterEach(() => {
    process.env.MCP_BEARER_TOKEN = originalToken;
    process.env.SECURITY_ALERT_WEBHOOK_URL = originalWebhook;
    vi.restoreAllMocks();
  });

  it("accepts the correct token", () => {
    const result = verifyBearerToken(dummyRequest, "correct-token-1234567890");
    expect(result).toEqual({
      token: "correct-token-1234567890",
      clientId: "personal",
      scopes: [],
    });
  });

  it("rejects an incorrect token of the same length", () => {
    expect(
      verifyBearerToken(dummyRequest, "wrong-token-1234567890")
    ).toBeUndefined();
  });

  it("rejects a token of a different length", () => {
    expect(verifyBearerToken(dummyRequest, "short")).toBeUndefined();
  });

  it("rejects when no token is provided", () => {
    expect(verifyBearerToken(dummyRequest, undefined)).toBeUndefined();
  });

  it("rejects any token when MCP_BEARER_TOKEN is not configured", () => {
    delete process.env.MCP_BEARER_TOKEN;
    expect(verifyBearerToken(dummyRequest, "anything")).toBeUndefined();
  });

  it("logs a structured event on failure, tagged with the specific reason", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    verifyBearerToken(dummyRequest, "wrong-token-1234567890");
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      event: "mcp_auth_failure",
      reason: "invalid_token",
      path: "/api/mcp",
    });

    errSpy.mockClear();
    verifyBearerToken(dummyRequest, undefined);
    expect(JSON.parse(errSpy.mock.calls[0][0] as string)).toMatchObject({
      reason: "missing_token",
    });

    errSpy.mockClear();
    delete process.env.MCP_BEARER_TOKEN;
    verifyBearerToken(dummyRequest, "anything");
    expect(JSON.parse(errSpy.mock.calls[0][0] as string)).toMatchObject({
      reason: "server_not_configured",
    });
  });

  it("never logs anything on a successful auth", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    verifyBearerToken(dummyRequest, "correct-token-1234567890");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("never includes the presented or expected token value in the logged event", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    verifyBearerToken(dummyRequest, "wrong-token-1234567890");
    const loggedLine = errSpy.mock.calls[0][0] as string;
    expect(loggedLine).not.toContain("wrong-token-1234567890");
    expect(loggedLine).not.toContain("correct-token-1234567890");
  });
});
