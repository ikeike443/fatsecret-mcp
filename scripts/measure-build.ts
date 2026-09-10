#!/usr/bin/env tsx
// Runs `next build` and records how long it took, where the time went, and how
// big the output is — then grades the result against the budgets in
// build-perf.config.json. This is what CI runs instead of a bare `next build`
// (`npm run build:measure`), so build duration is a tracked number rather than
// something you only notice once CI feels slow.
//
// What it produces:
//   - a JSON metric file per run under .build-metrics/ (uploaded as a CI
//     artifact, so a run's timings survive log expiry)
//   - a Markdown table in the GitHub Actions step summary
//   - a non-zero exit code when the build blows its budget (use --warn-only to
//     report without failing — CI does, and enforces the same budgets after the
//     E2E tests instead, via scripts/check-build-budget.ts)
//
// Per-phase timings come from Next.js' own build trace (.next/trace,
// .next/trace-build), so a slowdown can be attributed to Turbopack compilation
// vs. type checking vs. static generation instead of just "the build".
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import {
  parseTraceSpans,
  summarizeBuildPhases,
  evaluateBudget,
  formatBytes,
  formatDuration,
  formatPercent,
  renderMarkdownTable,
  statusIcon,
  type BudgetEvaluation,
  type BuildPhase,
  type BuildPhaseSummary,
} from "./lib/buildMetrics";
import { loadBuildPerfConfig } from "./lib/buildPerfConfig";
import { decideBuildOutcome } from "./lib/buildPerfOutcomes";
import { appendStepSummary, emitAnnotation } from "./lib/githubActions";

const ROOT = path.resolve(import.meta.dirname, "..");

interface BuildMetrics {
  schemaVersion: 1;
  recordedAt: string;
  success: boolean;
  exitCode: number;
  env: {
    node: string;
    next: string | null;
    platform: string;
    arch: string;
    cpus: number;
    totalMemoryBytes: number;
    ci: boolean;
  };
  git: { sha: string | null; ref: string | null };
  ciRun: { runId: string; runAttempt: string; workflow: string; job: string } | null;
  cache: { state: "cold" | "warm"; bytesBefore: number; bytesAfter: number };
  duration: {
    wallMs: number;
    tracedTotalMs: number | null;
    phases: BuildPhase[];
  };
  artifacts: {
    outputBytes: number;
    serverBytes: number;
    staticBytes: number;
  };
  budgets: {
    duration: BudgetEvaluation;
    artifactSize: BudgetEvaluation;
    cacheSize: BudgetEvaluation;
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "warn-only": { type: "boolean", default: false },
      "metrics-dir": { type: "string", default: ".build-metrics" },
      "no-summary": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      [
        "Usage: npm run build:measure [-- <options>]",
        "",
        "Options:",
        "  --warn-only          report a budget breach without failing",
        "  --metrics-dir <dir>  where to write metric JSON (default .build-metrics)",
        "  --no-summary         skip the GitHub Actions step summary",
      ].join("\n"),
    );
    return;
  }

  const config = await loadBuildPerfConfig(ROOT);
  const nextDir = path.join(ROOT, ".next");
  const cacheDir = path.join(nextDir, "cache");

  // Measured *before* the build: a warm build reuses Turbopack's filesystem
  // cache and is expected to be much faster, so it is graded differently.
  const cacheBytesBefore = await directorySize(cacheDir);
  const cacheState = cacheBytesBefore >= config.build.warmCacheMinBytes ? "warm" : "cold";

  console.log(
    `> measuring \`next build\` (${cacheState} cache: ${formatBytes(cacheBytesBefore)} in .next/cache)`,
  );

  const startedAt = new Date();
  const start = performance.now();
  const exitCode = await runNextBuild();
  const wallMs = performance.now() - start;

  const [cacheBytesAfter, outputBytes, serverBytes, staticBytes, phaseSummary] = await Promise.all([
    directorySize(cacheDir),
    directorySize(nextDir, { exclude: [cacheDir] }),
    directorySize(path.join(nextDir, "server")),
    directorySize(path.join(nextDir, "static")),
    // A failed build may not have flushed a trace, and the previous build's
    // trace is still on disk — reporting that as this build's breakdown would be
    // a lie, so a failed build gets no phase breakdown at all.
    exitCode === 0 ? readBuildPhases(nextDir) : Promise.resolve(EMPTY_PHASE_SUMMARY),
  ]);

  const durationBudget = evaluateBudget(
    wallMs,
    cacheState === "warm" ? config.build.warmBudgetMs : config.build.coldBudgetMs,
    config.build.warnRatio,
  );
  const artifactBudget = evaluateBudget(
    outputBytes,
    config.build.artifactBudgetBytes,
    config.build.warnRatio,
  );
  const cacheBudget = evaluateBudget(
    cacheBytesAfter,
    config.build.cacheBudgetBytes,
    config.build.warnRatio,
  );

  const metrics: BuildMetrics = {
    schemaVersion: 1,
    recordedAt: startedAt.toISOString(),
    success: exitCode === 0,
    exitCode,
    env: {
      node: process.version,
      next: await readNextVersion(),
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      ci: process.env.CI === "true",
    },
    git: {
      sha: process.env.GITHUB_SHA ?? (await gitRevParse()),
      ref: process.env.GITHUB_REF ?? null,
    },
    ciRun: process.env.GITHUB_RUN_ID
      ? {
          runId: process.env.GITHUB_RUN_ID,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
          workflow: process.env.GITHUB_WORKFLOW ?? "",
          job: process.env.GITHUB_JOB ?? "",
        }
      : null,
    cache: { state: cacheState, bytesBefore: cacheBytesBefore, bytesAfter: cacheBytesAfter },
    duration: { wallMs, tracedTotalMs: phaseSummary.totalMs, phases: phaseSummary.phases },
    artifacts: { outputBytes, serverBytes, staticBytes },
    budgets: { duration: durationBudget, artifactSize: artifactBudget, cacheSize: cacheBudget },
  };

  const metricsPath = await writeMetrics(metrics, values["metrics-dir"]);
  const report = renderReport(metrics, metricsPath);
  console.log(`\n${report}`);
  if (!values["no-summary"]) await appendStepSummary(report);

  const outcome = decideBuildOutcome({
    buildSucceeded: exitCode === 0,
    cacheState,
    ci: process.env.CI === "true",
    warnOnly: values["warn-only"] === true,
    durationBudget,
    artifactBudget,
    cacheBudget,
  });
  for (const annotation of outcome.annotations) emitAnnotation(annotation);

  if (exitCode !== 0) {
    // The build itself failed; its own output already explains why.
    process.exitCode = exitCode;
    return;
  }
  if (outcome.failureMessage) console.error(`\n${outcome.failureMessage}`);
  process.exitCode = outcome.exitCode;
}

function runNextBuild(): Promise<number> {
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextBin)) {
    throw new Error(`Next.js CLI not found at ${nextBin} — run \`npm ci\` first`);
  }
  // Spawned directly (not via `npm run build`) so the measured wall time is the
  // build itself, without an extra npm process in the middle.
  const child = spawn(process.execPath, [nextBin, "build"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`next build terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const EMPTY_PHASE_SUMMARY: BuildPhaseSummary = { totalMs: null, phases: [], rootTags: {} };

async function readBuildPhases(nextDir: string) {
  // Next.js splits its trace: `.next/trace-build` holds the root `next-build`
  // span and the top-level phases, `.next/trace` the finer-grained children.
  const contents = await Promise.all(
    ["trace-build", "trace"].map(async (file) => {
      try {
        return await readFile(path.join(nextDir, file), "utf-8");
      } catch {
        return "";
      }
    }),
  );
  return summarizeBuildPhases(parseTraceSpans(contents.join("\n")));
}

interface DirectorySizeOptions {
  exclude?: string[];
}

/** Total size of a directory's files in bytes; 0 if it does not exist. */
async function directorySize(dir: string, options: DirectorySizeOptions = {}): Promise<number> {
  const excluded = new Set((options.exclude ?? []).map((entry) => path.resolve(entry)));
  if (excluded.has(path.resolve(dir))) return 0;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (excluded.has(path.resolve(entryPath))) return 0;
      if (entry.isDirectory()) return directorySize(entryPath, options);
      if (!entry.isFile()) return 0; // symlinks: counted where they point, if at all
      try {
        return (await stat(entryPath)).size;
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

async function readNextVersion(): Promise<string | null> {
  try {
    const pkg = await readFile(path.join(ROOT, "node_modules", "next", "package.json"), "utf-8");
    const version = (JSON.parse(pkg) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function gitRevParse(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

async function writeMetrics(metrics: BuildMetrics, metricsDir: string): Promise<string> {
  const dir = path.resolve(ROOT, metricsDir);
  await mkdir(dir, { recursive: true });
  const runLabel = metrics.ciRun
    ? `${metrics.ciRun.runId}-${metrics.ciRun.runAttempt}`
    : metrics.recordedAt.replaceAll(/[:.]/g, "-");
  const contents = `${JSON.stringify(metrics, null, 2)}\n`;
  const runPath = path.join(dir, `build-${runLabel}.json`);
  await Promise.all([
    writeFile(runPath, contents),
    writeFile(path.join(dir, "latest.json"), contents),
  ]);
  return path.relative(ROOT, runPath);
}

function renderReport(metrics: BuildMetrics, metricsPath: string): string {
  const { duration, budgets, cache, artifacts } = metrics;
  const headline = metrics.success
    ? `${statusIcon(budgets.duration.status)} Build finished in ${formatDuration(duration.wallMs)} (${cache.state} cache)`
    : `❌ Build failed after ${formatDuration(duration.wallMs)}`;

  const overview = renderMarkdownTable(
    ["Metric", "Value", "Budget", "Status"],
    [
      [
        "Wall-clock duration",
        formatDuration(duration.wallMs),
        `${formatDuration(budgets.duration.budget)} (${cache.state})`,
        `${statusIcon(budgets.duration.status)} ${formatPercent(budgets.duration.ratio)} of budget`,
      ],
      [
        "Traced `next-build` span",
        duration.tracedTotalMs === null ? "n/a" : formatDuration(duration.tracedTotalMs),
        "—",
        "—",
      ],
      [
        "Output size (`.next` minus cache)",
        formatBytes(artifacts.outputBytes),
        formatBytes(budgets.artifactSize.budget),
        `${statusIcon(budgets.artifactSize.status)} ${formatPercent(budgets.artifactSize.ratio)} of budget`,
      ],
      [
        "Turbopack cache (`.next/cache`)",
        `${formatBytes(cache.bytesBefore)} → ${formatBytes(cache.bytesAfter)}`,
        formatBytes(budgets.cacheSize.budget),
        `${cache.state === "warm" ? "♻️ reused" : "🧊 cold"} · ${formatPercent(budgets.cacheSize.ratio)} of budget`,
      ],
    ],
  );

  const sections = [`### ${headline}`, "", overview];

  if (duration.phases.length > 0) {
    sections.push(
      "",
      "<details><summary>Where the build time went</summary>",
      "",
      "Top-level phases from Next.js' build trace. They can overlap (Turbopack " +
        "compilation and type checking run concurrently), so shares need not sum to 100%.",
      "",
      renderMarkdownTable(
        ["Phase", "Duration", "Share of build"],
        duration.phases
          .slice(0, 10)
          .map((phase) => [
            `\`${phase.name}\``,
            formatDuration(phase.durationMs),
            formatPercent(phase.share),
          ]),
      ),
      "",
      "</details>",
    );
  }

  sections.push(
    "",
    `Metrics: \`${metricsPath}\` · node ${metrics.env.node} · next ${metrics.env.next ?? "?"} · ${metrics.env.cpus} CPUs`,
  );
  return sections.join("\n");
}

main().catch((error) => {
  console.error(
    "\nBuild measurement failed:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
