# fatsecret-mcp

![CI](https://github.com/ikeike443/fatsecret-mcp/actions/workflows/ci.yml/badge.svg)

A personal remote MCP (Model Context Protocol) server that lets Claude search [FatSecret](https://platform.fatsecret.com/)'s food/recipe database and read/write your own food diary, weight, and exercise log directly in conversation. Deployed on Vercel's free Hobby tier. Sibling project to [fitness-mcp](https://github.com/ikeike443/fitness-mcp) (Hevy) — one MCP server per product, sharing the same auth pattern.

## License

[MIT](./LICENSE)

## Status

- **Search (Phase 2)**: implemented — `search_foods`, `get_food_detail`, `search_recipes`, `get_recipe_detail`, `find_food_by_barcode`. No FatSecret user authorization needed; only the OAuth 2.0 Client ID/Secret from FatSecret's developer console.
- **Diary/weight/exercise/profile (Phase 4)**: implemented, and **partially verified against a real FatSecret account** — `get_profile`, `get_food_diary`, and `get_exercise_diary` are now confirmed live; `create_exercise_entry`, `weight.update`, and `find_food_by_barcode` are still unverified best-effort reconstructions (see "What's unverified" below for the full breakdown).
- **3-legged OAuth1 setup script (Phase 3)**: implemented (`scripts/fatsecret-oauth-setup.ts`), not yet run against a real FatSecret account.

## Two authentication layers

This server sits between Claude and FatSecret, and each of those two relationships is authenticated completely differently — that's the main thing to understand before touching the code.

```
Claude  <──①── this server (fatsecret-mcp)  ──②──>  FatSecret API
```

**① Claude ↔ this server** — a single shared secret, same pattern as fitness-mcp. Claude sends `Authorization: Bearer <MCP_BEARER_TOKEN>` on every request; `lib/auth.ts` checks it. Since Claude's static-header option is still beta-gated, this server also runs its own minimal OAuth 2.1 authorization server (`lib/oauth.ts`, `/api/oauth/authorize`, `/api/oauth/token`) so Claude's standard OAuth Client ID/Secret fields work as an always-available fallback — see fitness-mcp's README for the full reasoning, which applies unchanged here.

**② this server ↔ FatSecret** — this is where it gets more complex than fitness-mcp, because FatSecret itself uses **two different OAuth versions for two different kinds of API method**, and there is no way around that — it's how FatSecret's API is designed, not a choice made here:

| FatSecret method category | Example methods | How this server authenticates |
|---|---|---|
| **Signed Request** (no specific user involved) | `foods.search`, `food.get`, `recipes.search`, `recipe.get`, `food.find_id_for_barcode` | OAuth 2.0 **Client Credentials** — `lib/fatsecret/appAuth.ts` fetches and caches an app-level bearer token from `oauth.fatsecret.com`. Fully automatic; no human interaction after the one-time developer registration. |
| **Signed & Delegated Request** (reads/writes *your* FatSecret account) | `food_entries.*`, `food_entry.*`, `weights.get_month`, `weight.update`, `exercise_entries.*`, `profile.get`, `foods.get_favorites` | OAuth **1.0a**, 3-legged, HMAC-SHA1 signed — `lib/fatsecret/oauth1.ts`. FatSecret does not support OAuth 2.0 for these methods at all, so there is no way to avoid OAuth1 here. This requires a **one-time interactive authorization** (Phase 3, below) where you log into FatSecret in a browser and approve this app; the resulting access token/secret are then reused automatically forever after (see caveat under Phase 3). |

Concretely: `search_foods`/`get_food_detail`/`search_recipes`/`get_recipe_detail`/`find_food_by_barcode` work as soon as you've registered a FatSecret app and set `FATSECRET_CLIENT_ID`/`FATSECRET_CLIENT_SECRET`. Every other tool additionally needs `FATSECRET_CONSUMER_KEY`/`FATSECRET_CONSUMER_SECRET` (OAuth1 — a *different* credential pair from the same FatSecret app) and `FATSECRET_ACCESS_TOKEN`/`FATSECRET_ACCESS_TOKEN_SECRET` (obtained by running the setup script once).

## Tools exposed

| Tool | Type | Auth needed | Description |
|---|---|---|---|
| `search_foods` | read | OAuth2 (app) | Search FatSecret's food database by name |
| `get_food_detail` | read | OAuth2 (app) | Full per-serving nutrition for one food |
| `search_recipes` | read | OAuth2 (app) | Search FatSecret's recipe database |
| `get_recipe_detail` | read | OAuth2 (app) | Full ingredients/directions for one recipe |
| `find_food_by_barcode` | read | OAuth2 (app) | Resolve a GTIN-13 barcode to a foodId — needs the `barcode` scope, possibly Premier-only |
| `get_food_diary` | read | OAuth1 (user) | List food diary entries for a date |
| `get_favorite_foods` | read | OAuth1 (user) | List favorited foods |
| `get_most_eaten_foods` | read | OAuth1 (user) | List most-eaten foods, optionally by meal |
| `get_recently_eaten_foods` | read | OAuth1 (user) | List recently-eaten foods, optionally by meal |
| `get_weight_history` | read | OAuth1 (user) | List weight entries for a month — possibly Premier-only |
| `get_exercise_diary` | read | OAuth1 (user) | List exercise entries for a date |
| `get_profile` | read | OAuth1 (user) | Get the user's FatSecret profile summary |
| `create_food_diary_entry` | write | OAuth1 (user) | Log a food to the diary |
| `update_food_diary_entry` | write | OAuth1 (user) | Update an existing diary entry |
| `delete_food_diary_entry` | write | OAuth1 (user) | Delete a diary entry |
| `update_weight` | write | OAuth1 (user) | Log/update a weight entry — possibly Premier-only |
| `create_exercise_entry` | write | OAuth1 (user) | Log an exercise entry |

### Write tools are dry-run by default

Same design as fitness-mcp: every write tool requires a `confirm: true` argument. Their descriptions instruct the calling LLM to show the user exactly what will be written and get explicit go-ahead first. That's a structural nudge, not a guarantee — the same LLM deciding whether to call the tool also sets `confirm`, and there is no scope separation between read/write tools at the authentication layer, so any caller holding a valid `MCP_BEARER_TOKEN` can invoke any tool.

### What's unverified

No FatSecret API registration existed while this project was first built, so most of it started as best-effort reconstructions. Since then it's been checked against a real account for some tools — status below:

- **Confirmed live, matches the implementation exactly**: `search_foods` (`foods.search`), `get_food_diary` (`food_entries.get`, including the `meal` field's real capitalization, e.g. `"Breakfast"`).
- **Confirmed live, fixed after checking**: `get_profile` (`profile.get`) — a real response included `height_cm`, which wasn't surfaced as a field yet; now added.
- **Confirmed live, real shape is more complex than assumed**: `get_exercise_diary` (`exercise_entries.get`). The method/envelope are real, but a real entry synced from a connected health app (`{exercise_id: "184", exercise_name: "Google Health Connect", minutes: "1440", calories: "1655"}` — a full day's aggregated activity, not a single workout) has **no `exercise_entry_id` and no `date_int` at all**. `lib/fatsecret/exercise.ts` now handles this defensively (missing fields become `null`, not a crash or a misleading fabricated value) and keeps the full raw entry under `raw`. Still open: whether a *manually*-logged exercise (via the FatSecret app) has an id/date the way `food_entries.get`'s entries do — untested.
- **Still unverified / best-effort reconstructions**: `food.find_id_for_barcode`'s response shape, `weight.update`'s param names, and `create_exercise_entry`'s method name and params (the exercise-diary discovery above means its whole "individual creatable entry" data-model assumption may not hold — see the warning in `lib/fatsecret/exercise.ts`). Treat these as a starting point, not verified truth.
- Run the manual verification checklist below against a real account for anything in the two bullets above, and fix up any mismatches you find (the unit tests in `lib/fatsecret/*.test.ts` will need matching updates).

## Setup

1. **Register a FatSecret Platform API app** at https://platform.fatsecret.com/. You'll get:
   - An **OAuth 2.0 Client ID/Secret** (for `FATSECRET_CLIENT_ID`/`FATSECRET_CLIENT_SECRET`).
   - An **OAuth 1.0 Consumer Key/Secret** (for `FATSECRET_CONSUMER_KEY`/`FATSECRET_CONSUMER_SECRET`) — a separate pair from the same app, not the same as the OAuth2 credentials above.
   - Check which scopes your plan includes (`basic` / `premier` / `barcode` / ...) — `weights.get_month`/`weight.update`/`find_food_by_barcode` are reported to require Premier or the `barcode`/`premier` scopes; confirm this against your own plan and adjust `FATSECRET_OAUTH2_SCOPE` if needed.
   - **Allowlist your outbound IP(s)** for OAuth2 token requests — FatSecret requires this (up to 15 addresses/ranges). If deploying to Vercel, this needs a static outbound IP (e.g. via a Vercel-supported egress proxy/addon); Vercel's default serverless functions don't have a fixed IP.
2. **Run the local dev server once** to smoke-test search (Phase 2 only needs step 1):
   ```bash
   npm install
   cp .env.example .env.local   # fill in FATSECRET_CLIENT_ID/SECRET + the MCP_BEARER_TOKEN/OAuth trio
   vercel dev
   ```
3. **Run the one-time 3-legged OAuth1 setup** (needed for every tool except the 5 search/detail ones) — see Phase 3 below.
4. **Deploy to Vercel** — see Deploy below.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in real values
vercel dev
```

Smoke test (replace `$MCP_BEARER_TOKEN`):

```bash
curl -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Should return the 17 tools above. A request with a missing/wrong token should get `401`.

## Phase 3: one-time 3-legged OAuth1 setup

Every tool except `search_foods`/`get_food_detail`/`search_recipes`/`get_recipe_detail`/`find_food_by_barcode` needs an OAuth1 access token/secret bound to *your* FatSecret account. Obtain it once:

```bash
npm run fatsecret:oauth-setup
```

This (`scripts/fatsecret-oauth-setup.ts`) will:
1. Request an unauthorized request token from FatSecret.
2. Print an authorization URL — open it, log into FatSecret, and approve. FatSecret shows a confirmation code.
3. Prompt you to paste that code, then exchange it for a permanent access token/secret.
4. Write `FATSECRET_ACCESS_TOKEN`/`FATSECRET_ACCESS_TOKEN_SECRET` into `.env.local`.

Then also add those same two values to Vercel's environment variables (`.env.local` is never deployed) — see Deploy below.

Per FatSecret's docs this access token does not expire. If it's ever revoked (e.g. you remove the app's access from your FatSecret account settings), just re-run the script to get a new one — see fitness-mcp's `derive()` pattern in spirit: losing a credential here isn't a disaster, it's a one-command fix, just an interactive one this time instead of a deterministic re-derivation.

## Generating the Claude-facing secrets from one memorable passphrase

`MCP_BEARER_TOKEN`, `OAUTH_CLIENT_ID`, and `OAUTH_CLIENT_SECRET` (layer ① — Claude ↔ this server, unrelated to the FatSecret credentials above) can all be derived deterministically from a single master passphrase, so losing the stored values isn't a disaster — just re-derive them:

```bash
derive() {
  if [ -z "$MASTER_PASSPHRASE" ]; then
    printf "Master passphrase: "
    read -rs MASTER_PASSPHRASE
    echo
  fi
  echo -n "$1" | openssl dgst -sha256 -hmac "$MASTER_PASSPHRASE" -hex | awk '{print $2}'
}

derive "fatsecret-mcp:bearer-token"        # → MCP_BEARER_TOKEN
derive "fatsecret-mcp:oauth-client-id"     # → OAUTH_CLIENT_ID
derive "fatsecret-mcp:oauth-client-secret" # → OAUTH_CLIENT_SECRET
```

The label strings aren't secret (they're safe to keep in this README) — only the passphrase is. Running `derive` again with the same passphrase always reproduces the same values. This does **not** apply to the FatSecret-side credentials (`FATSECRET_CLIENT_ID/SECRET`, `FATSECRET_CONSUMER_KEY/SECRET`, `FATSECRET_ACCESS_TOKEN/SECRET`) — those come from FatSecret's developer console and the OAuth1 setup script, not from this passphrase.

## Testing

Three layers, all run in CI (`.github/workflows/ci.yml`) on every push/PR — none require real FatSecret secrets, so they work the same in a public repo:

```bash
npm run test        # unit + integration (vitest) — pure logic, plus the real Next.js
                     # route handler exercised with fetch mocked
npm run build
npm run test:e2e     # starts a real `next start` server and hits it over real HTTP
                      # (node's built-in test runner, no extra dependency)
```

- **Unit** (`lib/**/*.test.ts`): bearer-token verification, OAuth2.1 code signing/PKCE/redirect-URI allowlisting (RFC 7636 test vector included), FatSecret OAuth2 Client Credentials token fetch/cache/refresh (`lib/fatsecret/appAuth.test.ts`), OAuth1 HMAC-SHA1 signing cross-checked against an independent reimplementation (`lib/fatsecret/oauth1.test.ts`), and every `lib/fatsecret/*.ts` response-shape normalization (single-object-vs-array, numeric-string-vs-number, empty-response quirks).
- **Integration** (`test/integration/*.test.ts`): the real `app/api/mcp/route.ts` handler wired to the real `lib/fatsecret/*` modules with only `fetch` mocked, covering both the OAuth2 (Signed Request) and OAuth1 (Signed & Delegated) tool paths, and confirm-gating on every write tool; the real `/api/oauth/authorize`/`/api/oauth/token` routes; the `.well-known` OAuth metadata routes.
- **E2E** (`test/e2e/*.e2e.test.mjs`): boots the production build and asserts over real HTTP — health check, 401 on bad/missing auth, `tools/list` returns all 17 tools, OAuth discovery metadata, and a full authorization-code + PKCE round trip. Doesn't exercise real FatSecret data (CI has no real credentials by design).

### Manually verifying against a real FatSecret account

CI never touches real FatSecret data, and — per "What's unverified" above — some of this server's assumptions about FatSecret's exact response shapes haven't been checked against a real account at all. After registering and running the OAuth1 setup script, work through this checklist and fix any mismatches you find:

1. ~~Set real `FATSECRET_CLIENT_ID`/`FATSECRET_CLIENT_SECRET` in `.env.local`, run `vercel dev`, and call `search_foods` with a real query~~ — **done**, confirmed working against a real account. Still do this for `get_food_detail` if you haven't yet — confirm it returns sane nutrition numbers.
2. Call `search_recipes` and `get_recipe_detail` similarly. **Still open.**
3. If your plan includes the `barcode` scope, call `find_food_by_barcode` with a real product's barcode and confirm the response shape matches `lib/fatsecret/foods.ts`'s `RawFindIdForBarcodeResponse` — fix it if not. **Still open.**
4. ~~Run `npm run fatsecret:oauth-setup`, then call `get_profile` and `get_food_diary`~~ — **done**. `get_food_diary` matched exactly; `get_profile` was missing `heightCm`, now fixed — see "What's unverified" above.
5. Call `create_food_diary_entry` with `confirm: true` and an obviously-throwaway entry, then `get_food_diary` for the same date and confirm it shows up with the right food/serving/quantity/meal. Then `update_food_diary_entry` it, and `delete_food_diary_entry` it — confirm each round-trips. **Still open** — note `meal` comes back capitalized (`"Breakfast"`) from `get_food_diary`; worth double-checking `create_food_diary_entry`/`update_food_diary_entry` accept that same casing on write (or whatever casing FatSecret's write side actually expects) before assuming it's fine.
6. If your plan includes weight tracking, call `update_weight` with `confirm: true` and confirm `get_weight_history` reflects it. **Still open.**
7. `create_exercise_entry` and `get_exercise_diary` are the least-verified pair in this codebase. `get_exercise_diary`'s method/envelope are now confirmed real, but revealed the exercise diary's data model is more complex than assumed (see "What's unverified" above) — before trusting `create_exercise_entry`, log an exercise **manually in the FatSecret app** first and re-check `get_exercise_diary` to see whether a manual entry has an `exercise_entry_id`/`date_int` the way food entries do; that'll tell you whether "individual creatable entry" is even the right model here, before you try `create_exercise_entry` itself against real data.
8. Never commit real FatSecret credentials, and never run this checklist in CI.

## Environment variables

| Variable | Purpose |
|---|---|
| `FATSECRET_CLIENT_ID` / `FATSECRET_CLIENT_SECRET` | OAuth 2.0 Client Credentials — Signed Request methods (search/detail tools) |
| `FATSECRET_OAUTH2_SCOPE` | Optional. Space-delimited OAuth2 scope(s), default `basic`. Add `barcode`/`premier` as needed |
| `FATSECRET_FOOD_GET_METHOD` | Optional. Defaults to `food.get.v4`; override (e.g. `food.get`) if your plan lacks v4 access |
| `FATSECRET_CONSUMER_KEY` / `FATSECRET_CONSUMER_SECRET` | OAuth 1.0 Consumer Key/Secret — signs both the one-time setup script and every Signed & Delegated call |
| `FATSECRET_ACCESS_TOKEN` / `FATSECRET_ACCESS_TOKEN_SECRET` | OAuth 1.0 access token/secret for *your* FatSecret account — obtained via `npm run fatsecret:oauth-setup` (Phase 3) |
| `MCP_BEARER_TOKEN` | Shared secret this server requires on every request, and the access_token our OAuth flow issues |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | Credentials for this server's own minimal OAuth authorization server |
| `OAUTH_ALLOWED_REDIRECT_HOSTS` | Optional. Comma-separated allowlist for `/api/oauth/authorize`'s `redirect_uri`. Defaults to `claude.ai,claude.com` |

Set these in the Vercel project's Environment Variables (Production + Preview). Never commit real values — `.env.example` only documents the names.

## Deploy

1. `vercel link`
2. `vercel env add FATSECRET_CLIENT_ID` (repeat for every variable in the table above that you have a value for — at minimum `FATSECRET_CLIENT_ID`/`SECRET`, `MCP_BEARER_TOKEN`, `OAUTH_CLIENT_ID`/`SECRET`; add the `FATSECRET_CONSUMER_*`/`FATSECRET_ACCESS_TOKEN*` pair once you've run the OAuth1 setup script)
3. Connect this GitHub repo in the Vercel dashboard for auto-deploy on push to `main`, or run `vercel --prod` manually.
4. Note the deployed URL (check Project → Settings → Domains, since `fatsecret-mcp.vercel.app` may already be taken on Vercel's shared namespace).
5. **Allowlist that deployment's outbound IP** in the FatSecret developer console for OAuth2 token requests (see Setup step 1) — this is the step most likely to bite in production since Vercel serverless functions don't have a fixed IP by default.

## Connect to Claude

Custom connectors can only be **added** from claude.ai (web) or the desktop app — not from the mobile app. Once added there, they're usable from mobile automatically.

1. On claude.ai: Settings → Connectors → Add custom connector.
2. Name: `FatSecret`. URL: `https://<your-deployment>/api/mcp`.
3. If your account has the "Request headers" beta: add `Authorization: Bearer <MCP_BEARER_TOKEN>` there and skip to step 5.
4. Otherwise, open Advanced settings and fill in **OAuth Client ID** / **OAuth Client Secret** with the `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` values set in Vercel. Claude will discover the `/authorize` and `/token` endpoints automatically via this server's `.well-known` metadata.
5. Save. Claude should list the 17 tools above.

Try asking: "バナナのカロリーを教えて" (tell me a banana's calories), or "今日の朝食にバナナを1本記録して" (log a banana for breakfast today — once Phase 3/4 are set up and verified).

## Acknowledgements

The 3-legged OAuth1 flow design was informed by [fcoury/fatsecret-mcp](https://github.com/fcoury/fatsecret-mcp) (MIT), which exposes the OAuth flow as MCP tools themselves; this project instead runs it once as a standalone setup script (`scripts/fatsecret-oauth-setup.ts`), since it's built for a single personal FatSecret account rather than multi-user use. No code was copied from it.
