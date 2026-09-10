#!/usr/bin/env tsx
// Compares this CI run's per-step timings against the recent history of
// successful runs on the baseline branch, using the GitHub Actions API as the
// timing store (`npm run build:perf-report`). Without this, CI duration only
// ever gets noticed anecdotally — with it, a build that got 1.5x slower shows up
// as a warning in the run summary, next to the numbers that prove it.
//
// Authentication: GITHUB_TOKEN / GH_TOKEN, or an authenticated `gh` CLI when run
// locally. With no token available the report is skipped (exit 0) rather than
// failing whatever invoked it.
//
// This is a read-only observer, so unless --fail-on-regression asks for it, it
// must never be the reason a run is red: an unreachable or unhappy GitHub API
// (a 404 after a workflow rename, a 5xx, a rate limit) is reported as a warning
// and exits 0. Only a detected regression, with --fail-on-regression, exits 1.
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  detectRegression,
  formatDuration,
  formatSignedDuration,
  jobDurationMs,
  renderMarkdownTable,
  stepDurationsMs,
  summarizeDurations,
  type WorkflowJob,
} from "./lib/buildMetrics";
import {
  loadBuildPerfConfig,
  MAX_HISTORY_RUNS,
  type BuildPerfConfig,
} from "./lib/buildPerfConfig";
import { decideTrendOutcome, type StepTrend } from "./lib/buildPerfOutcomes";
import { appendStepSummary, emitAnnotation } from "./lib/githubActions";

const ROOT = path.resolve(import.meta.dirname, "..");
const API_ROOT = process.env.GITHUB_API_URL ?? "https://api.github.com";
/** Baseline needs at least this many samples before a comparison means anything. */
const MIN_BASELINE_SAMPLES = 3;
/** `owner/name`, checked before it is interpolated into an API URL path. */
const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;

interface WorkflowRun {
  id: number;
  head_sha: string;
  head_branch: string | null;
  created_at: string;
  html_url: string;
}

interface TrendReport {
  schemaVersion: 1;
  generatedAt: string;
  repo: string;
  workflow: string;
  job: string;
  baselineBranch: string;
  baselineRuns: number;
  /** Baseline runs whose job could not be fetched — the baseline is that short. */
  baselineFetchFailures: number;
  currentRun: { id: number; sha: string; url: string } | null;
  steps: StepTrend[];
  regressions: string[];
}

interface ReportOptions {
  repo: string | undefined;
  workflow: string;
  job: string;
  branch: string;
  historyRuns: number;
  failOnRegression: boolean;
  metricsDir: string;
  noSummary: boolean;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      workflow: { type: "string" },
      job: { type: "string" },
      branch: { type: "string" },
      limit: { type: "string" },
      "fail-on-regression": { type: "boolean", default: false },
      "metrics-dir": { type: "string", default: ".build-metrics" },
      "no-summary": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      [
        "Usage: npm run build:perf-report [-- <options>]",
        "",
        "Options:",
        "  --repo <owner/name>     default: $GITHUB_REPOSITORY or the origin remote",
        "  --workflow <file>       workflow file name (default from build-perf.config.json)",
        "  --job <name>            job whose steps are compared",
        "  --branch <name>         baseline branch",
        `  --limit <n>             how many recent successful runs to sample (2-${MAX_HISTORY_RUNS})`,
        "  --fail-on-regression    exit non-zero when a tracked step regressed;",
        "                          also makes an API failure fail the run",
        "  --metrics-dir <dir>     where to write the JSON report",
        "  --no-summary            skip the GitHub Actions step summary",
      ].join("\n"),
    );
    return;
  }

  const config = await loadBuildPerfConfig(ROOT);
  const historyRuns = values.limit ? Number.parseInt(values.limit, 10) : config.trend.historyRuns;
  // The same bounds the config schema enforces: below 2 there is nothing to
  // compare, and GitHub will not page beyond MAX_HISTORY_RUNS per request, so a
  // larger --limit would be silently clamped instead of honoured.
  if (!Number.isInteger(historyRuns) || historyRuns < 2 || historyRuns > MAX_HISTORY_RUNS) {
    throw new Error(
      `--limit must be an integer between 2 and ${MAX_HISTORY_RUNS}, got ${values.limit}`,
    );
  }
  if (values.repo !== undefined && !REPO_SLUG.test(values.repo)) {
    throw new Error(`--repo must look like owner/name, got "${values.repo}"`);
  }

  const options: ReportOptions = {
    repo: values.repo,
    workflow: values.workflow ?? config.trend.workflow,
    job: values.job ?? config.trend.job,
    branch: values.branch ?? config.trend.baselineBranch,
    historyRuns,
    failOnRegression: values["fail-on-regression"] === true,
    metricsDir: values["metrics-dir"] ?? ".build-metrics",
    noSummary: values["no-summary"] === true,
  };

  try {
    await runReport(config, options);
  } catch (error) {
    if (options.failOnRegression) throw error;
    // Read-only and warn-only: whatever went wrong with the GitHub API, this
    // report is not worth failing someone's PR over.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`\nCI timing trend report unavailable: ${reason}`);
    emitAnnotation({
      level: "warning",
      title: "CI timing trend unavailable",
      message: `${reason} — no timings were compared for this run.`,
    });
  }
}

async function runReport(config: BuildPerfConfig, options: ReportOptions): Promise<void> {
  const { workflow, job, branch, historyRuns } = options;

  const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? (await repoFromGitRemote());
  if (!repo) {
    skip("Could not determine the repository (pass --repo owner/name).");
    return;
  }
  if (!REPO_SLUG.test(repo)) {
    skip(`"${repo}" does not look like an owner/name repository — skipping.`);
    return;
  }

  const token = await resolveToken();
  if (!token) {
    skip(
      "No GitHub token available (set GITHUB_TOKEN or run `gh auth login`) — " +
        "skipping the CI build-timing trend report.",
    );
    return;
  }

  let baselineRuns: WorkflowRun[];
  let currentJob: WorkflowJob | null;
  let currentRun: WorkflowRun | null = null;
  try {
    baselineRuns = await fetchSuccessfulRuns({ repo, workflow, branch, perPage: historyRuns, token });
    const currentRunId = process.env.GITHUB_RUN_ID
      ? Number.parseInt(process.env.GITHUB_RUN_ID, 10)
      : baselineRuns[0]?.id;
    if (!currentRunId) {
      skip(`No successful ${workflow} runs found for ${repo}@${branch} yet.`);
      return;
    }
    currentRun = baselineRuns.find((run) => run.id === currentRunId) ?? null;
    // One extra run is fetched so that dropping the current one still leaves
    // `historyRuns` samples; on a PR run it is not in the list at all, so the
    // list has to be trimmed back down to the documented size.
    baselineRuns = baselineRuns.filter((run) => run.id !== currentRunId).slice(0, historyRuns);
    currentJob = await fetchJob({ repo, runId: currentRunId, job, token });
    if (!currentJob) {
      skip(`Run ${currentRunId} has no job named "${job}" — nothing to compare.`);
      return;
    }
    if (!currentRun) {
      currentRun = { id: currentRunId, head_sha: process.env.GITHUB_SHA ?? "", head_branch: null, created_at: new Date().toISOString(), html_url: `${serverUrl()}/${repo}/actions/runs/${currentRunId}` };
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      skip("GitHub API returned 401 — the token is invalid or expired; skipping.");
      return;
    }
    if (error instanceof ApiError && error.status === 403) {
      skip(
        "GitHub API returned 403 — the token lacks `actions: read`, or this run is " +
          "rate limited; skipping.",
      );
      return;
    }
    throw error;
  }

  // allSettled, not `.catch(() => null)`: a rejected fetch shortens the baseline
  // and has to be reported, while a run that simply has no job by that name
  // (an older workflow) is a legitimately absent sample.
  const baselineResults = await Promise.allSettled(
    baselineRuns.map((run) => fetchJob({ repo, runId: run.id, job, token })),
  );
  const baselineJobs = baselineResults.flatMap((result) =>
    result.status === "fulfilled" && result.value !== null ? [result.value] : [],
  );
  const baselineFetchFailures = baselineResults.filter(
    (result) => result.status === "rejected",
  ).length;

  const report = buildTrendReport({
    config,
    repo,
    workflow,
    job,
    branch,
    currentRun,
    currentJob,
    baselineJobs,
    baselineFetchFailures,
  });

  const reportPath = await writeReport(report, options.metricsDir);
  const markdown = renderReport(report, reportPath);
  console.log(markdown);
  if (!options.noSummary) await appendStepSummary(markdown);

  const outcome = decideTrendOutcome({
    steps: report.steps,
    trackedSteps: config.trend.trackedSteps,
    baselineFetchFailures,
    baselineRuns: report.baselineRuns,
    failOnRegression: options.failOnRegression,
  });
  for (const annotation of outcome.annotations) emitAnnotation(annotation);
  process.exitCode = outcome.exitCode;
}

function buildTrendReport(input: {
  config: BuildPerfConfig;
  repo: string;
  workflow: string;
  job: string;
  branch: string;
  currentRun: WorkflowRun | null;
  currentJob: WorkflowJob;
  baselineJobs: WorkflowJob[];
  baselineFetchFailures: number;
}): TrendReport {
  const { config, currentJob, baselineJobs } = input;
  const currentSteps = stepDurationsMs(currentJob);
  const baselineSteps = baselineJobs.map(stepDurationsMs);

  const trackedNames = [...config.trend.trackedSteps, TOTAL_JOB_LABEL];
  const steps: StepTrend[] = trackedNames.map((step) => {
    const currentMs =
      step === TOTAL_JOB_LABEL ? jobDurationMs(currentJob) : (currentSteps.get(step) ?? null);
    const samples =
      step === TOTAL_JOB_LABEL
        ? baselineJobs
            .map(jobDurationMs)
            .filter((ms): ms is number => ms !== null)
        : baselineSteps
            .map((durations) => durations.get(step))
            .filter((ms): ms is number => ms !== undefined);

    const baseline = samples.length >= MIN_BASELINE_SAMPLES ? summarizeDurations(samples) : null;
    const regression =
      currentMs !== null && baseline !== null
        ? detectRegression({
            current: currentMs,
            baseline: baseline.p50,
            ratioThreshold: config.trend.regressionRatio,
            minDelta: config.trend.minRegressionDeltaMs,
          })
        : null;
    return { step, currentMs, baseline, regression };
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: input.repo,
    workflow: input.workflow,
    job: input.job,
    baselineBranch: input.branch,
    baselineRuns: baselineJobs.length,
    baselineFetchFailures: input.baselineFetchFailures,
    currentRun: input.currentRun
      ? { id: input.currentRun.id, sha: input.currentRun.head_sha, url: input.currentRun.html_url }
      : null,
    steps,
    regressions: steps.filter((step) => step.regression?.regressed).map((step) => step.step),
  };
}

const TOTAL_JOB_LABEL = "Total job";

function renderReport(report: TrendReport, reportPath: string): string {
  const rows = report.steps.map((step) => [
    step.step === TOTAL_JOB_LABEL ? `**${step.step}**` : `\`${step.step}\``,
    step.currentMs === null ? "n/a" : formatDuration(step.currentMs),
    step.baseline ? formatDuration(step.baseline.p50) : "n/a",
    step.baseline ? formatDuration(step.baseline.p90) : "n/a",
    step.baseline ? formatDuration(step.baseline.max) : "n/a",
    step.regression ? formatSignedDuration(step.regression.delta) : "n/a",
    step.regression ? (step.regression.regressed ? "⚠️ regressed" : "✅") : "—",
  ]);

  const lines = [
    `### ⏱️ CI timing trend — \`${report.job}\` job of \`${report.workflow}\``,
    "",
    (report.baselineRuns >= MIN_BASELINE_SAMPLES
      ? `Baseline: last ${report.baselineRuns} successful runs on \`${report.baselineBranch}\`.`
      : `Baseline: only ${report.baselineRuns} comparable run(s) on \`${report.baselineBranch}\` so far — ` +
        `need ${MIN_BASELINE_SAMPLES} before deltas are meaningful.`) +
      (report.baselineFetchFailures > 0
        ? ` ⚠️ ${report.baselineFetchFailures} run(s) could not be fetched from the GitHub API, ` +
          `so the baseline is that much shorter than it should be.`
        : ""),
    "",
    renderMarkdownTable(
      ["Step", "This run", "p50", "p90", "max", "Δ vs p50", "Status"],
      rows,
    ),
  ];

  if (report.regressions.length > 0) {
    lines.push(
      "",
      `⚠️ Slower than baseline: ${report.regressions.map((step) => `\`${step}\``).join(", ")}. ` +
        "Check the build phase breakdown in the build step's summary, and whether the " +
        "Next.js build cache was restored.",
    );
  }

  lines.push("", `Report: \`${reportPath}\``);
  return lines.join("\n");
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiGet<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "fatsecret-mcp-build-perf-report",
    },
  });
  if (!response.ok) {
    throw new ApiError(response.status, `GitHub API ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

async function fetchSuccessfulRuns(input: {
  repo: string;
  workflow: string;
  branch: string;
  perPage: number;
  token: string;
}): Promise<WorkflowRun[]> {
  const { repo, workflow, branch, perPage, token } = input;
  // `per_page + 1` because the current run is filtered out of the baseline.
  // `repo` is not encoded — it is a validated `owner/name` slug and its slash is
  // a real path separator.
  const url =
    `${API_ROOT}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs` +
    `?branch=${encodeURIComponent(branch)}&status=success&per_page=${Math.min(perPage + 1, MAX_HISTORY_RUNS)}`;
  const body = await apiGet<{ workflow_runs?: WorkflowRun[] }>(url, token);
  return body.workflow_runs ?? [];
}

async function fetchJob(input: {
  repo: string;
  runId: number;
  job: string;
  token: string;
}): Promise<WorkflowJob | null> {
  const { repo, runId, job, token } = input;
  const body = await apiGet<{ jobs?: WorkflowJob[] }>(
    `${API_ROOT}/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    token,
  );
  return body.jobs?.find((candidate) => candidate.name === job) ?? null;
}

async function resolveToken(): Promise<string | null> {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  return runCapture("gh", ["auth", "token"]);
}

async function repoFromGitRemote(): Promise<string | null> {
  const remote = await runCapture("git", ["remote", "get-url", "origin"]);
  if (!remote) return null;
  const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

function runCapture(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

function serverUrl(): string {
  return process.env.GITHUB_SERVER_URL ?? "https://github.com";
}

async function writeReport(report: TrendReport, metricsDir: string): Promise<string> {
  const dir = path.resolve(ROOT, metricsDir);
  await mkdir(dir, { recursive: true });
  const reportPath = path.join(dir, "ci-timing-trend.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return path.relative(ROOT, reportPath);
}

function skip(reason: string): void {
  console.log(`> build-perf-report skipped: ${reason}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::notice title=CI timing trend skipped::${reason}`);
  }
}

main().catch((error) => {
  console.error(
    "\nBuild timing trend report failed:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
