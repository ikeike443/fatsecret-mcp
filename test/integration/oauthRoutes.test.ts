import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET as authorizeGET } from "../../app/api/oauth/authorize/route";
import { POST as tokenPOST } from "../../app/api/oauth/token/route";
import { computeCodeChallengeS256 } from "../../lib/oauth";

function loggedSecurityEvents(errSpy: ReturnType<typeof vi.spyOn>) {
  return errSpy.mock.calls
    .map(([line]: [unknown]) => {
      try {
        return JSON.parse(line as string) as { event?: string; reason?: string };
      } catch {
        return undefined;
      }
    })
    .filter(
      (e: { event?: string; reason?: string } | undefined): e is { event?: string; reason?: string } =>
        e !== undefined
    );
}

const ORIGINAL_ENV = { ...process.env };
const REDIRECT_URI = "https://claude.ai/api/mcp/callback";
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = computeCodeChallengeS256(CODE_VERIFIER);

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.OAUTH_CLIENT_ID = "test-client-id";
  process.env.OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.MCP_BEARER_TOKEN = "test-bearer-token";
  delete process.env.OAUTH_ALLOWED_REDIRECT_HOSTS;
  // Every failure branch under test also calls reportSecurityFailure(),
  // which always logs via console.error — spy on it so tests can assert
  // the right event/reason was logged without the calls actually printing.
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  errSpy.mockRestore();
});

function authorizeRequest(overrides: Record<string, string | null> = {}) {
  const params: Record<string, string> = {
    response_type: "code",
    client_id: "test-client-id",
    redirect_uri: REDIRECT_URI,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    state: "xyz-state",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete params[key];
    else params[key] = value;
  }
  const url = new URL("https://fatsecret-mcp.example/api/oauth/authorize");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString());
}

async function getAuthorizationCode(): Promise<string> {
  const res = await authorizeGET(authorizeRequest());
  const location = res.headers.get("location")!;
  return new URL(location).searchParams.get("code")!;
}

function tokenRequest(body: Record<string, string>) {
  return new Request("https://fatsecret-mcp.example/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

describe("GET /api/oauth/authorize", () => {
  it("redirects with a code and echoes state back on success", async () => {
    const res = await authorizeGET(authorizeRequest());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("xyz-state");
  });

  it("returns 400 (no redirect) for a missing redirect_uri", async () => {
    const res = await authorizeGET(authorizeRequest({ redirect_uri: null }));
    expect(res.status).toBe(400);
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_authorize_failure",
        reason: "disallowed_redirect_uri",
      })
    );
  });

  it("returns 400 (no redirect) for a disallowed redirect_uri host", async () => {
    const res = await authorizeGET(
      authorizeRequest({ redirect_uri: "https://evil.example.com/callback" })
    );
    expect(res.status).toBe(400);
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_authorize_failure",
        reason: "disallowed_redirect_uri",
      })
    );
  });

  it("fails closed with a clean 500 (not an unhandled exception) when OAUTH_CLIENT_SECRET is unset", async () => {
    delete process.env.OAUTH_CLIENT_SECRET;
    const res = await authorizeGET(authorizeRequest());
    expect(res.status).toBe(500);
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_authorize_failure",
        reason: "server_not_configured",
      })
    );
  });

  it("redirects with error=unauthorized_client for a wrong client_id", async () => {
    const res = await authorizeGET(authorizeRequest({ client_id: "wrong-client" }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("unauthorized_client");
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_authorize_failure",
        reason: "unauthorized_client",
      })
    );
  });

  it("redirects with error=unsupported_response_type for a non-code response_type", async () => {
    const res = await authorizeGET(authorizeRequest({ response_type: "token" }));
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("unsupported_response_type");
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_authorize_failure",
        reason: "unsupported_response_type",
      })
    );
  });

  it("redirects with error=invalid_request when PKCE method isn't S256", async () => {
    const res = await authorizeGET(authorizeRequest({ code_challenge_method: "plain" }));
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_authorize_failure",
        reason: "invalid_request",
      })
    );
  });
});

describe("POST /api/oauth/token", () => {
  it("exchanges a valid code for the MCP_BEARER_TOKEN as access_token", async () => {
    const code = await getAuthorizationCode();
    const res = await tokenPOST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: "test-client-id",
        client_secret: "test-client-secret",
        code_verifier: CODE_VERIFIER,
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ access_token: "test-bearer-token", token_type: "Bearer" });
  });

  it("rejects a wrong client_secret with 401 invalid_client", async () => {
    const code = await getAuthorizationCode();
    const res = await tokenPOST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: "test-client-id",
        client_secret: "wrong-secret",
        code_verifier: CODE_VERIFIER,
      })
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_token_failure",
        reason: "invalid_client",
      })
    );
  });

  it("rejects a wrong code_verifier with invalid_grant", async () => {
    const code = await getAuthorizationCode();
    const res = await tokenPOST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: "test-client-id",
        client_secret: "test-client-secret",
        code_verifier: "totally-wrong-verifier",
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_token_failure",
        reason: "invalid_grant_pkce",
      })
    );
  });

  it("rejects a redirect_uri mismatch between authorize and token", async () => {
    const code = await getAuthorizationCode();
    const res = await tokenPOST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/some/other/callback",
        client_id: "test-client-id",
        client_secret: "test-client-secret",
        code_verifier: CODE_VERIFIER,
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_token_failure",
        reason: "invalid_grant_mismatch",
      })
    );
  });

  it("rejects an unsupported grant_type", async () => {
    const res = await tokenPOST(
      tokenRequest({
        grant_type: "client_credentials",
        code: "irrelevant",
        redirect_uri: REDIRECT_URI,
        client_id: "test-client-id",
        client_secret: "test-client-secret",
        code_verifier: CODE_VERIFIER,
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_token_failure",
        reason: "unsupported_grant_type",
      })
    );
  });

  it("rejects a request missing required fields with invalid_request", async () => {
    const res = await tokenPOST(
      tokenRequest({
        grant_type: "authorization_code",
        // code/client_id/client_secret/redirect_uri/code_verifier all omitted
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_token_failure",
        reason: "invalid_request_missing_fields",
      })
    );
  });

  it("rejects a bad/unknown authorization code with invalid_grant", async () => {
    const res = await tokenPOST(
      tokenRequest({
        grant_type: "authorization_code",
        code: "not-a-real-code",
        redirect_uri: REDIRECT_URI,
        client_id: "test-client-id",
        client_secret: "test-client-secret",
        code_verifier: CODE_VERIFIER,
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_token_failure",
        reason: "invalid_grant_bad_code",
      })
    );
  });

  it("fails closed with a clean 500 when MCP_BEARER_TOKEN is unset at redemption time", async () => {
    const code = await getAuthorizationCode();
    delete process.env.MCP_BEARER_TOKEN;
    const res = await tokenPOST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: "test-client-id",
        client_secret: "test-client-secret",
        code_verifier: CODE_VERIFIER,
      })
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("server_error");
    expect(loggedSecurityEvents(errSpy)).toContainEqual(
      expect.objectContaining({
        event: "oauth_token_failure",
        reason: "server_not_configured",
      })
    );
  });

  it("documented tradeoff: a code can be redeemed more than once within its TTL (no replay store)", async () => {
    const code = await getAuthorizationCode();
    const params = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      code_verifier: CODE_VERIFIER,
    };
    const first = await tokenPOST(tokenRequest(params));
    const second = await tokenPOST(tokenRequest(params));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
