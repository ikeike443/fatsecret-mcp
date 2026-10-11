<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Repository instructions

These instructions apply to the primary agent and every subagent. `CLAUDE.md` references this file; keep the shared workflow and repository-specific guidance here as the single source of truth. Keep this content outside the Next.js managed block above.

## Workflow

Use a feature branch and a pull request for changes. Do not commit directly to `main` or merge a PR unless the user explicitly asks.

Every time you open a PR as part of the current task, automatically run the following subagent cycle without waiting to be asked:

1. Spawn a review subagent to read this file, inspect the PR diff and CI, and post a GitHub PR review with findings first. Use inline comments for actionable findings with the correct diff path and line. The reviewer must not edit code. Do not invent findings or create repetitive comments merely to fill a review.
2. After the reviewer finishes, spawn a separate fix subagent to read this file and the review, assess each finding, make necessary fixes on the same PR branch, run relevant checks, and push the changes. If no fixes are needed, report that result without making unnecessary changes or rerunning unchanged checks.
3. Repeat with a new review subagent and a separate fix subagent for a second cycle. Recheck the current diff and CI; address any remaining findings. Reuse valid check results when the code has not changed.
4. Stop after at most two cycles, summarize findings, fixes, checks, and unresolved issues, and ask the user how to proceed. Do not start a third cycle or merge automatically. If a required credential, permission, or external service blocks progress, complete independent work and report the blocker rather than retrying indefinitely.

Explicit user instructions override this default for the relevant PR, including requests to review only, hold off on fixes, or use a different cycle limit.

For a review-only request about a PR that already existed before the current task, post findings first and wait for the user's instruction before fixing or pushing. Do not apply the automatic fix cycle unless the user asks for it.

## FatSecret-specific notes

- This server talks to FatSecret using two unrelated OAuth flows (OAuth 2.0 Client Credentials for search, OAuth 1.0a 3-legged for the user's own diary/weight/exercise data) — see README's "Two authentication layers" section before touching `lib/fatsecret/*`. Don't conflate `FATSECRET_CLIENT_ID/SECRET` (OAuth2) with `FATSECRET_CONSUMER_KEY/SECRET` (OAuth1) — they are different credential pairs from the same FatSecret app.
- Several response/param shapes in `lib/fatsecret/exercise.ts`, `lib/fatsecret/weight.ts`, and `lib/fatsecret/foods.ts`'s barcode lookup are flagged inline as unverified against a real FatSecret account (see README's "What's unverified" section) — when you get real API access, verify and fix these before treating them as correct, and update the corresponding unit tests to match.
- Never commit real FatSecret or MCP credentials, and never run the manual-verification checklist (README) in CI.
