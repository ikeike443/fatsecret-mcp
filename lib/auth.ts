import type { AuthInfo } from "@modelcontextprotocol/server";
import { timingSafeEqualStrings } from "./timingSafeEqualStrings";
import { reportSecurityFailure } from "./securityAlert";

/**
 * Verifies the bearer token against MCP_BEARER_TOKEN.
 *
 * This is the resource-server side check for the Claude <-> this server leg
 * (see README's "Two authentication layers" section for the full picture —
 * this is layer 1; lib/fatsecret/appAuth.ts and lib/fatsecret/oauth1.ts
 * handle layer 2, this server <-> the FatSecret API). The token itself can
 * arrive either as a static header (if a client supports that) or as the
 * access_token minted by our own minimal OAuth authorization server (see
 * lib/oauth.ts) —
 * either way it's the same MCP_BEARER_TOKEN value, so this check doesn't
 * need to know which path the caller took.
 *
 * Every failed check is logged (always) and, if SECURITY_ALERT_WEBHOOK_URL
 * is set, POSTed to that webhook (best-effort) — see lib/securityAlert.ts.
 * This is the only place that gates every tool call, so it's the one spot
 * where logging failed attempts gives real visibility into whether this
 * server's bearer token has leaked and is being probed.
 */
export function verifyBearerToken(
  req: Request,
  bearerToken?: string
): AuthInfo | undefined {
  const expected = process.env.MCP_BEARER_TOKEN;

  if (!expected) {
    // Server misconfiguration, not necessarily an attack — but still worth
    // knowing about immediately, and tagged with a distinct reason so it's
    // never confused with a real forged-token attempt in the logs/alerts.
    reportSecurityFailure(req, "mcp_auth_failure", "server_not_configured");
    return undefined;
  }
  if (!bearerToken) {
    reportSecurityFailure(req, "mcp_auth_failure", "missing_token");
    return undefined;
  }
  if (!timingSafeEqualStrings(bearerToken, expected)) {
    reportSecurityFailure(req, "mcp_auth_failure", "invalid_token");
    return undefined;
  }

  return {
    token: bearerToken,
    clientId: "personal",
    scopes: [],
  };
}
