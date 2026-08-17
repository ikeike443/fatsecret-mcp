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
// barcode, localization, nlp, image-recognition, feedback. FatSecret's docs
// (https://platform.fatsecret.com/docs/guides/authentication/oauth2) note
// this token request must come from an IP allowlisted in the FatSecret
// developer console (up to 15 addresses/ranges) — see README setup steps.

const TOKEN_URL = "https://oauth.fatsecret.com/connect/token";

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

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }).toString(),
  });

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

  const res = await fetch(API_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
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
