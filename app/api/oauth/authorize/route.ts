import {
  createAuthorizationCode,
  isAllowedRedirectUri,
  verifyClientId,
} from "@/lib/oauth";
import {
  buildSecurityEvent,
  logSecurityEvent,
  scheduleSecurityAlert,
} from "@/lib/securityAlert";

function reportOAuthFailure(
  req: Request,
  reason: string,
  extra?: Record<string, unknown>
): void {
  const evt = buildSecurityEvent(req, "oauth_authorize_failure", reason, extra);
  logSecurityEvent(evt);
  scheduleSecurityAlert(evt);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;

  const redirectUri = params.get("redirect_uri");
  if (!redirectUri || !isAllowedRedirectUri(redirectUri)) {
    // Probing this with an arbitrary redirect_uri is exactly the
    // open-redirector attempt isAllowedRedirectUri exists to block — worth
    // knowing about even though the request is already rejected.
    reportOAuthFailure(req, "disallowed_redirect_uri", {
      redirectUri: redirectUri ?? null,
    });
    return new Response("Invalid or disallowed redirect_uri", { status: 400 });
  }
  if (!process.env.OAUTH_CLIENT_SECRET) {
    // createAuthorizationCode signs with OAUTH_CLIENT_SECRET and throws if
    // it's unset — fail closed with a clean response instead of an
    // unhandled exception when only OAUTH_CLIENT_ID was configured.
    reportOAuthFailure(req, "server_not_configured");
    return new Response("Server misconfigured: OAUTH_CLIENT_SECRET is not set", {
      status: 500,
    });
  }

  const state = params.get("state");
  const responseType = params.get("response_type");
  const clientId = params.get("client_id");
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method");

  function redirectWithError(error: string) {
    const errUrl = new URL(redirectUri!);
    errUrl.searchParams.set("error", error);
    if (state) errUrl.searchParams.set("state", state);
    return Response.redirect(errUrl.toString(), 302);
  }

  if (responseType !== "code") {
    reportOAuthFailure(req, "unsupported_response_type", { responseType });
    return redirectWithError("unsupported_response_type");
  }
  if (!clientId || !verifyClientId(clientId)) {
    // A wrong/guessed client_id is a direct probe against this server's
    // OAuth surface — the one signal here most worth alerting on.
    reportOAuthFailure(req, "unauthorized_client", { clientId: clientId ?? null });
    return redirectWithError("unauthorized_client");
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    reportOAuthFailure(req, "invalid_request", {
      hasCodeChallenge: !!codeChallenge,
      codeChallengeMethod,
    });
    return redirectWithError("invalid_request");
  }

  // Auto-approve: this server has exactly one legitimate user, and the real
  // credential check happens at /token (client_secret), never here. See
  // lib/oauth.ts for the full reasoning.
  const code = createAuthorizationCode({
    clientId,
    codeChallenge,
    redirectUri,
  });

  const redirectTarget = new URL(redirectUri);
  redirectTarget.searchParams.set("code", code);
  if (state) redirectTarget.searchParams.set("state", state);

  return Response.redirect(redirectTarget.toString(), 302);
}
