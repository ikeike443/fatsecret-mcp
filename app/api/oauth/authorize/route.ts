import {
  createAuthorizationCode,
  isAllowedRedirectUri,
  verifyClientId,
} from "@/lib/oauth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;

  const redirectUri = params.get("redirect_uri");
  if (!redirectUri || !isAllowedRedirectUri(redirectUri)) {
    return new Response("Invalid or disallowed redirect_uri", { status: 400 });
  }
  if (!process.env.OAUTH_CLIENT_SECRET) {
    // createAuthorizationCode signs with OAUTH_CLIENT_SECRET and throws if
    // it's unset — fail closed with a clean response instead of an
    // unhandled exception when only OAUTH_CLIENT_ID was configured.
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
    return redirectWithError("unsupported_response_type");
  }
  if (!clientId || !verifyClientId(clientId)) {
    return redirectWithError("unauthorized_client");
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
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
