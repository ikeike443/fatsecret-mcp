// End-to-end test: starts a real `next start` server and hits it over real
// HTTP. Requires `npm run build` to have been run first.
//
// This intentionally does NOT exercise real FatSecret data — CI has no real
// FatSecret credentials (this repo may be public), so it only verifies the
// protocol-level surface: the server boots, serves the health-check page,
// enforces bearer auth, and lists all tools.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PORT = 3199;
const BASE_URL = `http://localhost:${PORT}`;
const BEARER_TOKEN = "e2e-test-bearer-token";
const OAUTH_CLIENT_ID = "e2e-oauth-client-id";
const OAUTH_CLIENT_SECRET = "e2e-oauth-client-secret";
const OAUTH_REDIRECT_URI = "https://claude.ai/api/mcp/callback";

function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let serverProcess;

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not accepting connections yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

before(async () => {
  const nextBin = path.join(REPO_ROOT, "node_modules", ".bin", "next");
  serverProcess = spawn(nextBin, ["start", "-p", String(PORT)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MCP_BEARER_TOKEN: BEARER_TOKEN,
      FATSECRET_CLIENT_ID: "dummy-e2e-client-id",
      FATSECRET_CLIENT_SECRET: "dummy-e2e-client-secret",
      FATSECRET_CONSUMER_KEY: "dummy-e2e-consumer-key",
      FATSECRET_CONSUMER_SECRET: "dummy-e2e-consumer-secret",
      FATSECRET_ACCESS_TOKEN: "dummy-e2e-access-token",
      FATSECRET_ACCESS_TOKEN_SECRET: "dummy-e2e-access-token-secret",
      OAUTH_CLIENT_ID,
      OAUTH_CLIENT_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[next start] ${chunk}`);
  });

  await waitForServer(BASE_URL);
});

after(() => {
  serverProcess?.kill();
});

test("root page responds and identifies the server", async () => {
  const res = await fetch(BASE_URL);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /fatsecret-mcp/);
});

test("rejects unauthenticated MCP requests with 401", async () => {
  const res = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
});

test("rejects requests with the wrong bearer token", async () => {
  const res = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer definitely-wrong",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
});

test("lists all 17 tools with a valid bearer token", async () => {
  const res = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${BEARER_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 200);

  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(dataLine, `expected an SSE "data:" line in response: ${text}`);
  const json = JSON.parse(dataLine.slice("data: ".length));

  const names = json.result.tools.map((t) => t.name).sort();
  assert.deepEqual(
    names,
    [
      "create_exercise_entry",
      "create_food_diary_entry",
      "delete_food_diary_entry",
      "find_food_by_barcode",
      "get_exercise_diary",
      "get_favorite_foods",
      "get_food_detail",
      "get_food_diary",
      "get_most_eaten_foods",
      "get_profile",
      "get_recently_eaten_foods",
      "get_recipe_detail",
      "get_weight_history",
      "search_foods",
      "search_recipes",
      "update_food_diary_entry",
      "update_weight",
    ].sort()
  );
});

test("serves OAuth authorization server metadata", async () => {
  const res = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.authorization_endpoint, `${BASE_URL}/api/oauth/authorize`);
  assert.equal(json.token_endpoint, `${BASE_URL}/api/oauth/token`);
  assert.deepEqual(json.code_challenge_methods_supported, ["S256"]);
});

test("serves OAuth protected resource metadata pointing at itself", async () => {
  const res = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.authorization_servers, [BASE_URL]);
});

test("full OAuth authorization-code + PKCE round trip yields a working access token", async () => {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  const state = "e2e-state-value";

  const authorizeUrl = new URL(`${BASE_URL}/api/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);

  const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorizeRes.status, 302);
  const location = new URL(authorizeRes.headers.get("location"));
  assert.equal(location.origin + location.pathname, OAUTH_REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), state);
  const code = location.searchParams.get("code");
  assert.ok(code, "expected an authorization code in the redirect");

  const tokenRes = await fetch(`${BASE_URL}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      code_verifier: codeVerifier,
    }).toString(),
  });
  assert.equal(tokenRes.status, 200);
  const tokenJson = await tokenRes.json();
  assert.equal(tokenJson.access_token, BEARER_TOKEN);
  assert.equal(tokenJson.token_type, "Bearer");

  // The minted access token must actually work against the MCP endpoint.
  const mcpRes = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokenJson.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcpRes.status, 200);
});

test("rejects a token exchange with the wrong client_secret", async () => {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());

  const authorizeUrl = new URL(`${BASE_URL}/api/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
  const code = new URL(authorizeRes.headers.get("location")).searchParams.get("code");

  const tokenRes = await fetch(`${BASE_URL}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
      client_id: OAUTH_CLIENT_ID,
      client_secret: "wrong-secret",
      code_verifier: codeVerifier,
    }).toString(),
  });
  assert.equal(tokenRes.status, 401);
});
