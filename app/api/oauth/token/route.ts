import {
  verifyAuthorizationCode,
  verifyClientCredentials,
  verifyPkce,
} from "@/lib/oauth";
import { reportSecurityFailure } from "@/lib/securityAlert";

function jsonError(error: string, status = 400) {
  return Response.json({ error }, { status });
}

async function readParams(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await req.json()) as Record<string, string>;
    return new URLSearchParams(body);
  }
  // Standard OAuth token requests are application/x-www-form-urlencoded.
  const formData = await req.formData();
  const params = new URLSearchParams();
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") params.set(key, value);
  }
  return params;
}

type RequiredTokenFields = {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
};

// Returns all five required fields together, or null if any is missing/empty.
// Returning the whole object rather than reporting *which* field was missing is
// deliberate: the single "invalid_request" response and single audit event below
// are what an OAuth client is entitled to see, and this shape is what keeps
// TypeScript narrowing every field to `string` at the call site (a
// `[...].some(v => !v)` presence check compiles but loses the narrowing).
function readRequiredFields(params: URLSearchParams): RequiredTokenFields | null {
  const code = params.get("code");
  const clientId = params.get("client_id");
  const clientSecret = params.get("client_secret");
  const redirectUri = params.get("redirect_uri");
  const codeVerifier = params.get("code_verifier");

  if (!code || !clientId || !clientSecret || !redirectUri || !codeVerifier) {
    return null;
  }
  return { code, clientId, clientSecret, redirectUri, codeVerifier };
}

export async function POST(req: Request) {
  let params: URLSearchParams;
  try {
    params = await readParams(req);
  } catch {
    return jsonError("invalid_request");
  }

  if (params.get("grant_type") !== "authorization_code") {
    reportSecurityFailure(req, "oauth_token_failure", "unsupported_grant_type", {
      grantType: params.get("grant_type"),
    });
    return jsonError("unsupported_grant_type");
  }

  const fields = readRequiredFields(params);
  if (!fields) {
    reportSecurityFailure(req, "oauth_token_failure", "invalid_request_missing_fields");
    return jsonError("invalid_request");
  }
  const { code, clientId, clientSecret, redirectUri, codeVerifier } = fields;

  if (!verifyClientCredentials(clientId, clientSecret)) {
    // The one check in this whole flow that most directly gates on a
    // genuine secret (OAUTH_CLIENT_SECRET) — a failure here is the
    // strongest single signal that someone is guessing at this server's
    // credentials rather than just misconfiguring a legitimate client.
    reportSecurityFailure(req, "oauth_token_failure", "invalid_client", { clientId });
    return jsonError("invalid_client", 401);
  }

  const payload = verifyAuthorizationCode(code);
  if (!payload) {
    reportSecurityFailure(req, "oauth_token_failure", "invalid_grant_bad_code");
    return jsonError("invalid_grant");
  }
  if (payload.clientId !== clientId || payload.redirectUri !== redirectUri) {
    reportSecurityFailure(req, "oauth_token_failure", "invalid_grant_mismatch");
    return jsonError("invalid_grant");
  }
  if (!verifyPkce(codeVerifier, payload.codeChallenge)) {
    reportSecurityFailure(req, "oauth_token_failure", "invalid_grant_pkce");
    return jsonError("invalid_grant");
  }

  const accessToken = process.env.MCP_BEARER_TOKEN;
  if (!accessToken) {
    reportSecurityFailure(req, "oauth_token_failure", "server_not_configured");
    return jsonError("server_error", 500);
  }

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
  });
}
