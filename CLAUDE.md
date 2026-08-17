@AGENTS.md

## Workflow

Propose changes via pull request (feature branch + PR), not by committing directly to `main`. Open the PR and let the user review/merge, unless they explicitly ask for a direct push.

Every time you open a PR in this repo, automatically follow up with a two-step subagent loop — don't wait to be asked:
1. Spawn a subagent to review the PR (diff + CI) and post its findings as a GitHub PR review, findings first, no inline fixing.
2. Only if that review turns up findings, spawn a second, separate subagent to address them and push the fixes to the same branch.
If the review finds nothing, stop after step 1 — no fix subagent needed.

This loop is the default when nothing else is specified. If the user gives explicit instructions about a specific self-opened PR — e.g. "just review this one, don't fix it yet", "hold off on fixing", or any other specific ask — those instructions win for that PR, overriding the automatic loop (including its automatic fix-and-push step), even though the assistant opened the PR itself.

When asked to review a PR that already existed before the current turn/request (e.g. reviewing someone else's PR, or a plain "review PR #N" request for a PR opened in an earlier session or task — as opposed to one the assistant is opening as part of the current task), post the review with findings first, as a separate step from fixing them. Don't fix-then-report in the same motion — it reads as unclear/backwards about what's already done vs. still open. Wait for the user (or a follow-up instruction) before pushing fixes for what the review found.
