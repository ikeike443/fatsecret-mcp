import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createAuthorizationCode,
  signAuthorizationCode,
  verifyAuthorizationCode,
  computeCodeChallengeS256,
  verifyPkce,
  verifyClientCredentials,
  verifyClientId,
  isAllowedRedirectUri,
} from "./oauth";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.OAUTH_CLIENT_ID = "test-client-id";
  process.env.OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.MCP_BEARER_TOKEN = "test-bearer-token";
  delete process.env.OAUTH_ALLOWED_REDIRECT_HOSTS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("authorization code sign/verify round trip", () => {
  it("verifies a freshly created code and returns its payload", () => {
    const code = createAuthorizationCode({
      clientId: "test-client-id",
      codeChallenge: "some-challenge",
      redirectUri: "https://claude.ai/callback",
    });

    const payload = verifyAuthorizationCode(code);
    expect(payload).toMatchObject({
      clientId: "test-client-id",
      codeChallenge: "some-challenge",
      redirectUri: "https://claude.ai/callback",
    });
  });

  it("rejects a code with a tampered payload", () => {
    const code = createAuthorizationCode({
      clientId: "test-client-id",
      codeChallenge: "some-challenge",
      redirectUri: "https://claude.ai/callback",
    });
    const [payloadPart, signaturePart] = code.split(".");
    const tampered = `${payloadPart}x.${signaturePart}`;
    expect(verifyAuthorizationCode(tampered)).toBeNull();
  });

  it("rejects a code with a tampered signature", () => {
    const code = createAuthorizationCode({
      clientId: "test-client-id",
      codeChallenge: "some-challenge",
      redirectUri: "https://claude.ai/callback",
    });
    const [payloadPart, signaturePart] = code.split(".");
    const tampered = `${payloadPart}.${signaturePart.slice(0, -1)}Z`;
    expect(verifyAuthorizationCode(tampered)).toBeNull();
  });

  it("rejects malformed codes", () => {
    expect(verifyAuthorizationCode("not-a-valid-code")).toBeNull();
    expect(verifyAuthorizationCode("")).toBeNull();
    expect(verifyAuthorizationCode("a.b.c")).toBeNull();
  });

  it("rejects a code signed with a different client secret", () => {
    const code = createAuthorizationCode({
      clientId: "test-client-id",
      codeChallenge: "some-challenge",
      redirectUri: "https://claude.ai/callback",
    });
    process.env.OAUTH_CLIENT_SECRET = "a-different-secret";
    expect(verifyAuthorizationCode(code)).toBeNull();
  });

  it("rejects an expired code", () => {
    const expired = signAuthorizationCode({
      clientId: "test-client-id",
      codeChallenge: "some-challenge",
      redirectUri: "https://claude.ai/callback",
      exp: Date.now() - 1,
    });
    expect(verifyAuthorizationCode(expired)).toBeNull();
  });

  it("accepts a code right up until its expiry, via a controlled clock", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const code = createAuthorizationCode({
        clientId: "test-client-id",
        codeChallenge: "some-challenge",
        redirectUri: "https://claude.ai/callback",
      });

      vi.setSystemTime(1_000_000 + 59_000); // just under the 60s TTL
      expect(verifyAuthorizationCode(code)).not.toBeNull();

      vi.setSystemTime(1_000_000 + 61_000); // just past the 60s TTL
      expect(verifyAuthorizationCode(code)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(computeCodeChallengeS256(codeVerifier)).toBe(expectedChallenge);
  });

  it("verifyPkce accepts the matching verifier and rejects a wrong one", () => {
    const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = computeCodeChallengeS256(codeVerifier);
    expect(verifyPkce(codeVerifier, challenge)).toBe(true);
    expect(verifyPkce("some-other-verifier", challenge)).toBe(false);
  });
});

describe("verifyClientCredentials / verifyClientId", () => {
  it("accepts the configured client id + secret", () => {
    expect(verifyClientCredentials("test-client-id", "test-client-secret")).toBe(true);
    expect(verifyClientId("test-client-id")).toBe(true);
  });

  it("rejects a wrong client id or secret", () => {
    expect(verifyClientCredentials("wrong-id", "test-client-secret")).toBe(false);
    expect(verifyClientCredentials("test-client-id", "wrong-secret")).toBe(false);
    expect(verifyClientId("wrong-id")).toBe(false);
  });

  it("rejects everything when the env vars aren't configured", () => {
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_CLIENT_SECRET;
    expect(verifyClientCredentials("test-client-id", "test-client-secret")).toBe(false);
    expect(verifyClientId("test-client-id")).toBe(false);
  });
});

describe("isAllowedRedirectUri", () => {
  it("allows the default Claude domains over https", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://sub.claude.ai/callback")).toBe(true);
  });

  it("rejects http (non-TLS) even for an allowed host", () => {
    expect(isAllowedRedirectUri("http://claude.ai/callback")).toBe(false);
  });

  it("rejects unrelated hosts", () => {
    expect(isAllowedRedirectUri("https://evil.example.com/callback")).toBe(false);
    expect(isAllowedRedirectUri("https://notclaude.ai/callback")).toBe(false);
  });

  it("rejects unparseable input", () => {
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });

  it("respects a custom OAUTH_ALLOWED_REDIRECT_HOSTS override", () => {
    process.env.OAUTH_ALLOWED_REDIRECT_HOSTS = "example.org";
    expect(isAllowedRedirectUri("https://example.org/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.ai/callback")).toBe(false);
  });
});
