// OAuth 1.0 HMAC-SHA1 signing for FatSecret's "Signed & Delegated Request"
// methods (food_entries.*, food_entry.*, weight.*, weights.*,
// exercise_entries.*, profile.get, foods.get_favorites, ...) — the methods
// that read/write a specific FatSecret user's data. FatSecret only supports
// OAuth 1.0's 3-legged flow for these; OAuth 2.0 cannot do them (see
// README's "Two authentication layers" section for why this whole file
// exists alongside lib/fatsecret/appAuth.ts's OAuth 2.0 Client Credentials).
//
// This module is also imported directly by scripts/fatsecret-oauth-setup.ts
// (the one-time interactive setup script — see README/Phase 3) to sign the
// request_token/access_token exchange, which happens before any
// FATSECRET_ACCESS_TOKEN exists.
import { createHmac, randomBytes } from "node:crypto";

export const REQUEST_TOKEN_URL =
  "https://authentication.fatsecret.com/oauth/request_token";
export const AUTHORIZE_URL = "https://authentication.fatsecret.com/oauth/authorize";
export const ACCESS_TOKEN_URL =
  "https://authentication.fatsecret.com/oauth/access_token";
export const API_BASE = "https://platform.fatsecret.com/rest/server.api";

/**
 * RFC 5849 percent-encoding: like encodeURIComponent, but also escapes
 * !'()* (which encodeURIComponent leaves alone), since OAuth1's signature
 * base string requires the stricter RFC 3986 unreserved-character set.
 */
export function percentEncode(input: string): string {
  return encodeURIComponent(input).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** Builds the OAuth1 signature base string per RFC 5849 §3.4.1. */
export function buildSignatureBaseString(
  httpMethod: string,
  url: string,
  params: Record<string, string>
): string {
  const normalizedParams = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");

  return [
    httpMethod.toUpperCase(),
    percentEncode(url),
    percentEncode(normalizedParams),
  ].join("&");
}

/** HMAC-SHA1(signingKey, baseString), base64-encoded — the only signature
 * method FatSecret supports. */
export function computeOAuth1Signature(
  httpMethod: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret = ""
): string {
  const baseString = buildSignatureBaseString(httpMethod, url, params);
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", signingKey).update(baseString).digest("base64");
}

function nonce(): string {
  return randomBytes(16).toString("hex");
}

function timestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
}

/**
 * Signs an OAuth1 request and returns the full set of request params
 * (oauth_* fields plus the caller's own params) with oauth_signature
 * included, ready to be sent as a POST body
 * (application/x-www-form-urlencoded) or a GET query string.
 */
export function signOAuth1Request(
  httpMethod: "GET" | "POST",
  url: string,
  params: Record<string, string>,
  credentials: OAuth1Credentials
): Record<string, string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp(),
    oauth_version: "1.0",
    ...(credentials.token ? { oauth_token: credentials.token } : {}),
  };

  const allParams = { ...params, ...oauthParams };
  const signature = computeOAuth1Signature(
    httpMethod,
    url,
    allParams,
    credentials.consumerSecret,
    credentials.tokenSecret
  );

  return { ...allParams, oauth_signature: signature };
}

function consumerCredentials(): { consumerKey: string; consumerSecret: string } {
  const consumerKey = process.env.FATSECRET_CONSUMER_KEY;
  const consumerSecret = process.env.FATSECRET_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) {
    throw new Error(
      "FATSECRET_CONSUMER_KEY / FATSECRET_CONSUMER_SECRET are not set"
    );
  }
  return { consumerKey, consumerSecret };
}

function delegatedCredentials(): OAuth1Credentials {
  const { consumerKey, consumerSecret } = consumerCredentials();
  const token = process.env.FATSECRET_ACCESS_TOKEN;
  const tokenSecret = process.env.FATSECRET_ACCESS_TOKEN_SECRET;
  if (!token || !tokenSecret) {
    throw new Error(
      "FATSECRET_ACCESS_TOKEN / FATSECRET_ACCESS_TOKEN_SECRET are not set — " +
        "run `npm run fatsecret:oauth-setup` once to obtain them (see README, Phase 3)."
    );
  }
  return { consumerKey, consumerSecret, token, tokenSecret };
}

/**
 * Calls a FatSecret "Signed & Delegated Request" method against the
 * authenticated user's own data, using the OAuth1 access token/secret from
 * FATSECRET_ACCESS_TOKEN / FATSECRET_ACCESS_TOKEN_SECRET (see
 * delegatedCredentials above — set once via `npm run fatsecret:oauth-setup`).
 */
export async function fatsecretDelegatedRequest<T>(
  method: string,
  params: Record<string, string | number | undefined>
): Promise<T> {
  const credentials = delegatedCredentials();

  const bodyParams: Record<string, string> = { method, format: "json" };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) bodyParams[key] = String(value);
  }

  const signedParams = signOAuth1Request("POST", API_BASE, bodyParams, credentials);

  const res = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(signedParams).toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FatSecret API error ${res.status}: ${text}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`FatSecret API returned non-JSON response: ${text}`);
  }

  // Same method-level-error-as-HTTP-200 behavior as the OAuth2 path — see
  // lib/fatsecret/appAuth.ts's fatsecretAppRequest for the same check.
  const errorField = (data as { error?: { code?: number; message?: string } })
    .error;
  if (errorField) {
    throw new Error(
      `FatSecret API error ${errorField.code ?? "?"}: ${
        errorField.message ?? JSON.stringify(errorField)
      }`
    );
  }

  return data as T;
}
