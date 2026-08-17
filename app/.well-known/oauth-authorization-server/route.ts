import { getPublicOrigin } from "mcp-handler";

/** RFC 8414 Authorization Server Metadata for our own minimal OAuth server. */
export async function GET(req: Request) {
  const origin = getPublicOrigin(req);

  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  });
}
