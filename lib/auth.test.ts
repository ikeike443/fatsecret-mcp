import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { verifyBearerToken } from "./auth";

describe("verifyBearerToken", () => {
  const originalToken = process.env.MCP_BEARER_TOKEN;
  const dummyRequest = new Request("https://example.com/api/mcp");

  beforeEach(() => {
    process.env.MCP_BEARER_TOKEN = "correct-token-1234567890";
  });

  afterEach(() => {
    process.env.MCP_BEARER_TOKEN = originalToken;
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
});
