#!/usr/bin/env tsx
// One-time interactive setup for FatSecret's OAuth 1.0 3-legged flow (see
// README Phase 3). Run once with `npm run fatsecret:oauth-setup`, after
// FATSECRET_CONSUMER_KEY/FATSECRET_CONSUMER_SECRET are set in .env.local.
// Never runs as part of the deployed server or CI — it's a developer-only
// tool that talks to FatSecret directly from your own machine/browser.
//
// What it does:
//   1. Requests an unauthorized request token (oauth/request_token).
//   2. Prints an authorize URL — open it, log into FatSecret, approve, and
//      copy the confirmation code FatSecret shows you.
//   3. Exchanges the request token + that code for a permanent access
//      token/secret (oauth/access_token).
//   4. Writes FATSECRET_ACCESS_TOKEN / FATSECRET_ACCESS_TOKEN_SECRET into
//      .env.local (creating it if needed, replacing existing values if
//      present) so lib/fatsecret/oauth1.ts's delegated requests can use
//      them immediately.
import { createInterface } from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  REQUEST_TOKEN_URL,
  AUTHORIZE_URL,
  ACCESS_TOKEN_URL,
  signOAuth1Request,
  type OAuth1Credentials,
} from "../lib/fatsecret/oauth1";

const ENV_LOCAL_PATH = path.resolve(import.meta.dirname, "..", ".env.local");

async function loadEnvLocal(): Promise<void> {
  let content: string;
  try {
    content = await readFile(ENV_LOCAL_PATH, "utf-8");
  } catch {
    return; // no .env.local yet — fine, caller may have exported vars directly
  }
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] === undefined) {
      process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }
}

async function upsertEnvLocal(values: Record<string, string>): Promise<void> {
  let content = "";
  try {
    content = await readFile(ENV_LOCAL_PATH, "utf-8");
  } catch {
    // .env.local doesn't exist yet — will be created below.
  }
  const lines = content.length > 0 ? content.split("\n") : [];
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.match(new RegExp(`^\\s*${key}\\s*=`)));
    if (idx >= 0) {
      lines[idx] = line;
    } else {
      lines.push(line);
    }
  }
  // Drop trailing blank lines, then ensure exactly one trailing newline.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  await writeFile(ENV_LOCAL_PATH, lines.join("\n") + "\n", "utf-8");
}

/** Parses FatSecret's application/x-www-form-urlencoded OAuth1 response bodies. */
function parseFormBody(text: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(text));
}

async function requestUnauthorizedToken(
  credentials: Pick<OAuth1Credentials, "consumerKey" | "consumerSecret">
): Promise<{ token: string; tokenSecret: string }> {
  const signedParams = signOAuth1Request(
    "POST",
    REQUEST_TOKEN_URL,
    { oauth_callback: "oob" },
    credentials
  );
  const res = await fetch(REQUEST_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(signedParams).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`request_token failed (${res.status}): ${text}`);
  }
  const parsed = parseFormBody(text);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error(`Unexpected request_token response: ${text}`);
  }
  if (parsed.oauth_callback_confirmed !== "true") {
    throw new Error(
      `request_token response did not confirm oauth_callback_confirmed=true: ${text}`
    );
  }
  return { token: parsed.oauth_token, tokenSecret: parsed.oauth_token_secret };
}

async function exchangeForAccessToken(
  credentials: OAuth1Credentials,
  verifier: string
): Promise<{ token: string; tokenSecret: string }> {
  const signedParams = signOAuth1Request(
    "POST",
    ACCESS_TOKEN_URL,
    { oauth_verifier: verifier },
    credentials
  );
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(signedParams).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`access_token failed (${res.status}): ${text}`);
  }
  const parsed = parseFormBody(text);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error(`Unexpected access_token response: ${text}`);
  }
  return { token: parsed.oauth_token, tokenSecret: parsed.oauth_token_secret };
}

async function main() {
  await loadEnvLocal();

  const consumerKey = process.env.FATSECRET_CONSUMER_KEY;
  const consumerSecret = process.env.FATSECRET_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) {
    console.error(
      "FATSECRET_CONSUMER_KEY / FATSECRET_CONSUMER_SECRET are not set.\n" +
        "Set them in .env.local (from your FatSecret developer console — OAuth 1.0 Consumer Key/Secret, not the OAuth 2.0 Client ID/Secret) and re-run this script."
    );
    process.exit(1);
  }

  console.log("Step 1/3: requesting an unauthorized request token...");
  const requestToken = await requestUnauthorizedToken({ consumerKey, consumerSecret });

  const authorizeUrl = `${AUTHORIZE_URL}?oauth_token=${encodeURIComponent(requestToken.token)}`;
  console.log("\nStep 2/3: authorize this app as yourself.");
  console.log(`Open this URL in a browser, log into FatSecret, and approve access:\n\n  ${authorizeUrl}\n`);
  console.log("FatSecret will show you a confirmation code (or redirect with oauth_verifier= in the URL if you used a callback) — copy it.");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const verifier = (await rl.question("\nPaste the confirmation code here: ")).trim();
  rl.close();

  if (!verifier) {
    console.error("No confirmation code entered — aborting.");
    process.exit(1);
  }

  console.log("\nStep 3/3: exchanging it for a permanent access token...");
  const accessToken = await exchangeForAccessToken(
    {
      consumerKey,
      consumerSecret,
      token: requestToken.token,
      tokenSecret: requestToken.tokenSecret,
    },
    verifier
  );

  await upsertEnvLocal({
    FATSECRET_ACCESS_TOKEN: accessToken.token,
    FATSECRET_ACCESS_TOKEN_SECRET: accessToken.tokenSecret,
  });

  console.log(`\nDone. Wrote FATSECRET_ACCESS_TOKEN / FATSECRET_ACCESS_TOKEN_SECRET to ${ENV_LOCAL_PATH}.`);
  console.log(
    "Also add the same two values to your Vercel project's environment variables " +
      "(vercel env add FATSECRET_ACCESS_TOKEN / vercel env add FATSECRET_ACCESS_TOKEN_SECRET) " +
      "before deploying — .env.local is never deployed. Per FatSecret's docs this access token does " +
      "not expire; if it's ever revoked (e.g. you remove the app's access from your FatSecret account), " +
      "re-run `npm run fatsecret:oauth-setup` to get a new one."
  );
}

main().catch((err) => {
  console.error("\nSetup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
