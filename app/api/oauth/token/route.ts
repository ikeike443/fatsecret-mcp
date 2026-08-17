import {
  verifyAuthorizationCode,
  verifyClientCredentials,
  verifyPkce,
} from "@/lib/oauth";

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

export async function POST(req: Request) {
  let params: URLSearchParams;
  try {
    params = await readParams(req);
  } catch {
    return jsonError("invalid_request");
  }

  if (params.get("grant_type") !== "authorization_code") {
    return jsonError("unsupported_grant_type");
  }

  const code = params.get("code");
  const clientId = params.get("client_id");
  const clientSecret = params.get("client_secret");
  const redirectUri = params.get("redirect_uri");
  const codeVerifier = params.get("code_verifier");

  if (!code || !clientId || !clientSecret || !redirectUri || !codeVerifier) {
    return jsonError("invalid_request");
  }

  if (!verifyClientCredentials(clientId, clientSecret)) {
    return jsonError("invalid_client", 401);
  }

  const payload = verifyAuthorizationCode(code);
  if (!payload) {
    return jsonError("invalid_grant");
  }
  if (payload.clientId !== clientId || payload.redirectUri !== redirectUri) {
    return jsonError("invalid_grant");
  }
  if (!verifyPkce(codeVerifier, payload.codeChallenge)) {
    return jsonError("invalid_grant");
  }

  const accessToken = process.env.MCP_BEARER_TOKEN;
  if (!accessToken) {
    return jsonError("server_error", 500);
  }

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
  });
}
