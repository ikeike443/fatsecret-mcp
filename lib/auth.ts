import type { AuthInfo } from "@modelcontextprotocol/server";
import { timingSafeEqualStrings } from "./timingSafeEqualStrings";

/**
 * Verifies the bearer token against MCP_BEARER_TOKEN.
 *
 * This is the resource-server side check for the Claude <-> this server leg
 * (see README's "Two authentication layers" section for the full picture —
 * this is layer 1; lib/fatsecret/appAuth.ts and lib/fatsecret/oauth1.ts
 * handle layer 2, this server <-> the FatSecret API). The token itself can
 * arrive either as a static header (if a client supports that) or as the
 * access_token minted by our own minimal OAuth authorization server (see
 * lib/oauth.ts) — either way it's the same MCP_BEARER_TOKEN value, so this
 * check doesn't need to know which path the caller took.
 */
export function verifyBearerToken(
  _req: Request,
  bearerToken?: string
): AuthInfo | undefined {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected || !bearerToken) return undefined;
  if (!timingSafeEqualStrings(bearerToken, expected)) return undefined;

  return {
    token: bearerToken,
    clientId: "personal",
    scopes: [],
  };
}
