import { createHmac, createHash } from "node:crypto";
import { timingSafeEqualStrings } from "./timingSafeEqualStrings";

/**
 * Minimal single-user OAuth 2.1 authorization server (Authorization Code +
 * PKCE), so Claude's custom connector can authenticate even without the
 * (beta, not-yet-rolled-out) static "Request headers" option.
 *
 * This is the Claude <-> this server leg only (see README's "Two
 * authentication layers" section) — unrelated to how this server itself
 * authenticates to the FatSecret API (lib/fatsecret/appAuth.ts,
 * lib/fatsecret/oauth1.ts).
 *
 * There is no client database, no login screen, and no stored session —
 * /authorize auto-approves. The actual credential check happens at /token:
 * a request can only exchange a code for an access token if it presents the
 * correct OAUTH_CLIENT_SECRET, which never appears in a browser-visible URL.
 * The issued access_token is just MCP_BEARER_TOKEN itself, so
 * lib/auth.ts's resource-server check is unchanged by any of this.
 *
 * Authorization codes are self-contained (HMAC-signed, short-lived) rather
 * than stored anywhere, so this stays stateless — no new infra needed.
 * Replay of a captured code is not separately defended against (no
 * used-code tracking): an attacker would still need the PKCE code_verifier
 * (never transmitted until the TLS-protected /token call) and the
 * OAUTH_CLIENT_SECRET to do anything with it, and codes expire in 60s. That
 * residual risk is judged acceptable for a personal single-user server.
 */

const CODE_TTL_MS = 60_000;

export interface AuthCodePayload {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLength), "base64");
}

function signingSecret(): string {
  const secret = process.env.OAUTH_CLIENT_SECRET;
  if (!secret) throw new Error("OAUTH_CLIENT_SECRET is not set");
  return secret;
}

export function signAuthorizationCode(payload: AuthCodePayload): string {
  const payloadJson = JSON.stringify(payload);
  const payloadPart = base64UrlEncode(payloadJson);
  const signature = createHmac("sha256", signingSecret())
    .update(payloadPart)
    .digest();
  return `${payloadPart}.${base64UrlEncode(signature)}`;
}

/**
 * Verifies signature and expiry. Returns the payload on success, or null if
 * the code is malformed, tampered with, or expired.
 */
export function verifyAuthorizationCode(code: string): AuthCodePayload | null {
  const parts = code.split(".");
  if (parts.length !== 2) return null;
  const [payloadPart, signaturePart] = parts;

  const expectedSignature = base64UrlEncode(
    createHmac("sha256", signingSecret()).update(payloadPart).digest()
  );
  if (!timingSafeEqualStrings(signaturePart, expectedSignature)) return null;

  let payload: AuthCodePayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadPart).toString("utf-8"));
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
  return payload;
}

export function createAuthorizationCode(
  fields: Omit<AuthCodePayload, "exp">
): string {
  return signAuthorizationCode({ ...fields, exp: Date.now() + CODE_TTL_MS });
}

/** PKCE: BASE64URL(SHA256(code_verifier)), per RFC 7636. */
export function computeCodeChallengeS256(codeVerifier: string): string {
  return base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
}

export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  return timingSafeEqualStrings(computeCodeChallengeS256(codeVerifier), codeChallenge);
}

export function verifyClientCredentials(
  clientId: string,
  clientSecret: string
): boolean {
  const expectedId = process.env.OAUTH_CLIENT_ID;
  const expectedSecret = process.env.OAUTH_CLIENT_SECRET;
  if (!expectedId || !expectedSecret) return false;
  return (
    timingSafeEqualStrings(clientId, expectedId) &&
    timingSafeEqualStrings(clientSecret, expectedSecret)
  );
}

export function verifyClientId(clientId: string): boolean {
  const expectedId = process.env.OAUTH_CLIENT_ID;
  if (!expectedId) return false;
  return timingSafeEqualStrings(clientId, expectedId);
}

/**
 * Redirect URIs are restricted to a configurable allowlist of hosts (rather
 * than an exact stored per-client URI, since there's no client database)
 * to stop /authorize being used as an open redirector. Configure via
 * OAUTH_ALLOWED_REDIRECT_HOSTS (comma-separated), defaulting to Claude's
 * own domains.
 */
export function isAllowedRedirectUri(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  const allowedHosts = (
    process.env.OAUTH_ALLOWED_REDIRECT_HOSTS ?? "claude.ai,claude.com"
  )
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  return allowedHosts.some(
    (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
  );
}
