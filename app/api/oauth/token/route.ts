import {
  verifyAuthorizationCode,
  verifyClientCredentials,
  verifyPkce,
} from "@/lib/oauth";
import {
  buildSecurityEvent,
  logSecurityEvent,
  scheduleSecurityAlert,
} from "@/lib/securityAlert";

function jsonError(error: string, status = 400) {
  return Response.json({ error }, { status });
}

function reportOAuthFailure(
  req: Request,
  reason: string,
  extra?: Record<string, unknown>
): void {
  const evt = buildSecurityEvent(req, "oauth_token_failure", reason, extra);
  logSecurityEvent(evt);
  scheduleSecurityAlert(evt);
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

export async function POST(req: Request) {
  let params: URLSearchParams;
  try {
    params = await readParams(req);
  } catch {
    return jsonError("invalid_request");
  }

  if (params.get("grant_type") !== "authorization_code") {
    reportOAuthFailure(req, "unsupported_grant_type", {
      grantType: params.get("grant_type"),
    });
    return jsonError("unsupported_grant_type");
  }

  const code = params.get("code");
  const clientId = params.get("client_id");
  const clientSecret = params.get("client_secret");
  const redirectUri = params.get("redirect_uri");
  const codeVerifier = params.get("code_verifier");

  if (!code || !clientId || !clientSecret || !redirectUri || !codeVerifier) {
    reportOAuthFailure(req, "invalid_request_missing_fields");
    return jsonError("invalid_request");
  }

  if (!verifyClientCredentials(clientId, clientSecret)) {
    // The one check in this whole flow that most directly gates on a
    // genuine secret (OAUTH_CLIENT_SECRET) — a failure here is the
    // strongest single signal that someone is guessing at this server's
    // credentials rather than just misconfiguring a legitimate client.
    reportOAuthFailure(req, "invalid_client", { clientId });
    return jsonError("invalid_client", 401);
  }

  const payload = verifyAuthorizationCode(code);
  if (!payload) {
    reportOAuthFailure(req, "invalid_grant_bad_code");
    return jsonError("invalid_grant");
  }
  if (payload.clientId !== clientId || payload.redirectUri !== redirectUri) {
    reportOAuthFailure(req, "invalid_grant_mismatch");
    return jsonError("invalid_grant");
  }
  if (!verifyPkce(codeVerifier, payload.codeChallenge)) {
    reportOAuthFailure(req, "invalid_grant_pkce");
    return jsonError("invalid_grant");
  }

  const accessToken = process.env.MCP_BEARER_TOKEN;
  if (!accessToken) {
    reportOAuthFailure(req, "server_not_configured");
    return jsonError("server_error", 500);
  }

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
  });
}
