// OAuth 2.0 Client Credentials for FatSecret's "Signed Request" methods
// (foods.search, food.get, recipes.search, recipe.get, food.find_id_for_barcode,
// ...) — the methods that don't need a specific FatSecret user's permission.
// This is layer 2's app-level half; see README's "Two authentication layers"
// section, and lib/fatsecret/oauth1.ts for the other half (Signed & Delegated
// Request methods, which OAuth 2.0 cannot do — see README for why).
//
// Confirmed against multiple independent sources (see git history / PR
// description for links): the token endpoint is oauth.fatsecret.com, HTTP
// Basic auth with client_id:client_secret, grant_type=client_credentials,
// and a space-delimited "scope" request param. Valid scopes: basic, premier,
// barcode, localization, nlp, image-recognition, feedback.
//
// IP allowlisting: confirmed against a real Vercel deployment (see git
// history) that FatSecret's IP restriction is NOT limited to the token
// endpoint — a request to platform.fatsecret.com/rest/server.api using a
// validly-issued token was still rejected (error code 21, "Invalid IP
// address detected") when made from a non-allowlisted IP. So both the
// token request AND every actual API call need to come from an allowlisted
// IP, not just the former as initially assumed. Since Vercel serverless
// functions don't have a fixed outbound IP, this module routes both
// requests through a fixed-IP HTTP proxy (e.g. Fixie, see README) whenever
// FIXIE_URL is set — see proxyDispatcher() below. Locally, where the
// machine's own IP is what you allowlist directly, just leave FIXIE_URL
// unset.
import { ProxyAgent } from "undici";

const TOKEN_URL = "https://oauth.fatsecret.com/connect/token";

// Lazily constructed so a missing/malformed FIXIE_URL only breaks requests
// that actually need it, and so tests that never set FIXIE_URL never pay
// for it. Cached (not one per request) since ProxyAgent manages its own
// connection pool internally — constructing a fresh one per call would
// defeat that.
let cachedDispatcher: ProxyAgent | undefined;
let cachedDispatcherUrl: string | undefined;

function proxyDispatcher(): ProxyAgent | undefined {
  const url = process.env.FIXIE_URL;
  if (!url) return undefined;
  if (cachedDispatcher && cachedDispatcherUrl === url) return cachedDispatcher;
  // FIXIE_URL changing mid-process is not expected in practice (env vars
  // don't change mid-lifetime on Vercel), but if it ever does, close the
  // outgoing dispatcher's connection pool instead of leaking it. Deliberately
  // fire-and-forget: proxyDispatcher() stays synchronous so this fix doesn't
  // ripple into withOptionalProxy() and its callers becoming async.
  cachedDispatcher?.close().catch(() => {});
  cachedDispatcher = new ProxyAgent(url);
  cachedDispatcherUrl = url;
  return cachedDispatcher;
}

// Node's global fetch (undici under the hood) accepts a `dispatcher` option
// that isn't part of the standard lib.dom.d.ts RequestInit type — this
// widens just enough to pass it through without an `any` cast at every call
// site. See https://nodejs.org/api/globals.html#fetch and undici's
// ProxyAgent docs.
type FetchInitWithDispatcher = RequestInit & { dispatcher?: ProxyAgent };

function withOptionalProxy(init: RequestInit): FetchInitWithDispatcher {
  const dispatcher = proxyDispatcher();
  return dispatcher ? { ...init, dispatcher } : init;
}

/** Test-only: clears the cached proxy dispatcher so a changed FIXIE_URL takes effect. */
export function _resetProxyDispatcherForTests(): void {
  cachedDispatcher = undefined;
  cachedDispatcherUrl = undefined;
}

interface CachedToken {
  accessToken: string;
  // Absolute time (ms since epoch) after which the token is treated as
  // expired. Refreshed a bit early (see EXPIRY_SAFETY_MARGIN_MS) so a
  // request never races a token that expires mid-flight.
  expiresAt: number;
}

// Module-level cache, one entry per requested scope string, so a warm
// Vercel Lambda instance reuses a token across requests instead of hitting
// FatSecret's token endpoint on every tool call. Best-effort only — a cold
// start just fetches a fresh token, correctness never depends on this.
const TOKEN_CACHE = new Map<string, CachedToken>();
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

function clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.FATSECRET_CLIENT_ID;
  const clientSecret = process.env.FATSECRET_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "FATSECRET_CLIENT_ID / FATSECRET_CLIENT_SECRET are not set"
    );
  }
  return { clientId, clientSecret };
}

function defaultScope(): string {
  // Space-delimited. "basic" covers foods/recipes search+detail. Add
  // "barcode" (find_food_by_barcode) or "premier" via
  // FATSECRET_OAUTH2_SCOPE if your FatSecret plan includes them — see
  // README's Premier-gated features note.
  return process.env.FATSECRET_OAUTH2_SCOPE ?? "basic";
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

async function fetchAppAccessToken(scope: string): Promise<CachedToken> {
  const { clientId, clientSecret } = clientCredentials();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  );

  const res = await fetch(
    TOKEN_URL,
    withOptionalProxy({
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope }).toString(),
    })
  );

  if (!res.ok) {
    throw new Error(
      `FatSecret OAuth2 token request failed ${res.status}: ${await res.text()}`
    );
  }

  const data = (await res.json()) as TokenResponse;
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - EXPIRY_SAFETY_MARGIN_MS,
  };
}

/** Returns a cached app-level access token, refreshing it if expired/absent. */
export async function getAppAccessToken(scope = defaultScope()): Promise<string> {
  const cached = TOKEN_CACHE.get(scope);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }
  const fresh = await fetchAppAccessToken(scope);
  TOKEN_CACHE.set(scope, fresh);
  return fresh.accessToken;
}

/** Test-only: clears the module-level token cache between test cases. */
export function _resetAppAccessTokenCacheForTests(): void {
  TOKEN_CACHE.clear();
}

const API_BASE = "https://platform.fatsecret.com/rest/server.api";

/**
 * Calls a FatSecret "Signed Request" method (see module doc comment above)
 * using an app-level OAuth 2.0 Client Credentials token — no per-user
 * authorization needed. Automatically fetches/refreshes the token.
 */
export async function fatsecretAppRequest<T>(
  method: string,
  params: Record<string, string | number | undefined>,
  scope?: string
): Promise<T> {
  const token = await getAppAccessToken(scope);

  const body = new URLSearchParams({ method, format: "json" });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.set(key, String(value));
  }

  const res = await fetch(
    API_BASE,
    withOptionalProxy({
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    })
  );

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

  // FatSecret reports method-level errors (bad food_id, missing param, etc.)
  // as HTTP 200 with an { error: { code, message } } body, not as an HTTP
  // error status — check for that explicitly or failures would silently
  // return a malformed/empty result to the caller.
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
