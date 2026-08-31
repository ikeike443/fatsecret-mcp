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
import { spawn } from "node:child_process";
import { writeFile, mkdir, appendFile } from "node:fs/promises";
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
  type DurationStats,
  type RegressionCheck,
  type WorkflowJob,
} from "./lib/buildMetrics";
import { loadBuildPerfConfig, type BuildPerfConfig } from "./lib/buildPerfConfig";

const ROOT = path.resolve(import.meta.dirname, "..");
const API_ROOT = process.env.GITHUB_API_URL ?? "https://api.github.com";
/** Baseline needs at least this many samples before a comparison means anything. */
const MIN_BASELINE_SAMPLES = 3;

interface WorkflowRun {
  id: number;
  head_sha: string;
  head_branch: string | null;
  created_at: string;
  html_url: string;
}

interface StepTrend {
  step: string;
  currentMs: number | null;
  baseline: DurationStats | null;
  regression: RegressionCheck | null;
}

interface TrendReport {
  schemaVersion: 1;
  generatedAt: string;
  repo: string;
  workflow: string;
  job: string;
  baselineBranch: string;
  baselineRuns: number;
  currentRun: { id: number; sha: string; url: string } | null;
  steps: StepTrend[];
  regressions: string[];
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
        "  --limit <n>             how many recent successful runs to sample",
        "  --fail-on-regression    exit non-zero when a tracked step regressed",
        "  --metrics-dir <dir>     where to write the JSON report",
        "  --no-summary            skip the GitHub Actions step summary",
      ].join("\n"),
    );
    return;
  }

  const config = await loadBuildPerfConfig(ROOT);
  const workflow = values.workflow ?? config.trend.workflow;
  const job = values.job ?? config.trend.job;
  const branch = values.branch ?? config.trend.baselineBranch;
  const historyRuns = values.limit ? Number.parseInt(values.limit, 10) : config.trend.historyRuns;
  if (!Number.isInteger(historyRuns) || historyRuns < 2) {
    throw new Error(`--limit must be an integer >= 2, got ${values.limit}`);
  }

  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? (await repoFromGitRemote());
  if (!repo) {
    skip("Could not determine the repository (pass --repo owner/name).");
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
    baselineRuns = baselineRuns.filter((run) => run.id !== currentRunId);
    currentJob = await fetchJob({ repo, runId: currentRunId, job, token });
    if (!currentJob) {
      skip(`Run ${currentRunId} has no job named "${job}" — nothing to compare.`);
      return;
    }
    if (!currentRun) {
      currentRun = { id: currentRunId, head_sha: process.env.GITHUB_SHA ?? "", head_branch: null, created_at: new Date().toISOString(), html_url: `${serverUrl()}/${repo}/actions/runs/${currentRunId}` };
    }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      skip(`GitHub API returned ${error.status} — the token lacks \`actions: read\`; skipping.`);
      return;
    }
    throw error;
  }

  const baselineJobs = (
    await Promise.all(
      baselineRuns.map((run) =>
        fetchJob({ repo, runId: run.id, job, token }).catch(() => null),
      ),
    )
  ).filter((candidate): candidate is WorkflowJob => candidate !== null);

  const report = buildTrendReport({
    config,
    repo,
    workflow,
    job,
    branch,
    currentRun,
    currentJob,
    baselineJobs,
  });

  const reportPath = await writeReport(report, values["metrics-dir"]);
  const markdown = renderReport(report, reportPath);
  console.log(markdown);
  if (!values["no-summary"]) await appendStepSummary(markdown);

  for (const step of report.steps) {
    if (step.regression?.regressed) {
      annotate(
        values["fail-on-regression"] ? "error" : "warning",
        `Build timing regression: ${step.step}`,
        `${formatDuration(step.regression.current)} vs ${formatDuration(step.regression.baseline)} baseline p50 ` +
          `(${formatSignedDuration(step.regression.delta)}, ${step.regression.ratio?.toFixed(2) ?? "?"}x)`,
      );
    }
  }

  if (report.regressions.length > 0 && values["fail-on-regression"]) {
    process.exitCode = 1;
  }
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
}): TrendReport {
  const { config, currentJob, baselineJobs } = input;
  const currentSteps = stepDurationsMs(currentJob);
  const baselineSteps = baselineJobs.map(stepDurationsMs);

  const trackedNames = [...config.trend.trackedSteps, TOTAL_JOB_LABEL];
  const steps: StepTrend[] = trackedNames.map((step) => {
    const currentMs =
      step === TOTAL_JOB_LABEL ? jobDurationMs(currentJob) : (currentSteps[step] ?? null);
    const samples =
      step === TOTAL_JOB_LABEL
        ? baselineJobs
            .map(jobDurationMs)
            .filter((ms): ms is number => ms !== null)
        : baselineSteps
            .map((durations) => durations[step])
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
    report.baselineRuns >= MIN_BASELINE_SAMPLES
      ? `Baseline: last ${report.baselineRuns} successful runs on \`${report.baselineBranch}\`.`
      : `Baseline: only ${report.baselineRuns} comparable run(s) on \`${report.baselineBranch}\` so far — ` +
        `need ${MIN_BASELINE_SAMPLES} before deltas are meaningful.`,
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
  const url =
    `${API_ROOT}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs` +
    `?branch=${encodeURIComponent(branch)}&status=success&per_page=${Math.min(perPage + 1, 100)}`;
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

function annotate(level: "warning" | "error", title: string, message: string): void {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::${level} title=${title}::${message}`);
  } else {
    console.log(`${level === "error" ? "ERROR" : "WARN"}: ${title} — ${message}`);
  }
}

function skip(reason: string): void {
  console.log(`> build-perf-report skipped: ${reason}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::notice title=CI timing trend skipped::${reason}`);
  }
}

async function appendStepSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  await appendFile(summaryPath, `${markdown}\n\n`);
}

main().catch((error) => {
  console.error(
    "\nBuild timing trend report failed:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
