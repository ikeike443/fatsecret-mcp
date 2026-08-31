#!/usr/bin/env tsx
// Enforces the build-performance budgets that `npm run build:measure` already
// graded, by re-reading the metrics it wrote (`npm run build:budget-check`).
//
// Why this is a separate step: CI measures the build with `--warn-only` so that
// a blown *performance* budget cannot stop the E2E tests — a correctness check —
// from running. This runs after them and turns the same verdict into a failure,
// so the budget still gates the run, just last instead of first.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { formatPercent } from "./lib/buildMetrics";
import { decideBuildOutcome } from "./lib/buildPerfOutcomes";
import { emitAnnotation } from "./lib/githubActions";

const ROOT = path.resolve(import.meta.dirname, "..");

const budgetSchema = z.object({
  actual: z.number(),
  budget: z.number(),
  ratio: z.number(),
  delta: z.number(),
  status: z.enum(["ok", "warn", "over"]),
  warnRatio: z.number(),
});

// Only the fields this check needs; measure-build.ts writes considerably more.
const metricsSchema = z.object({
  success: z.boolean(),
  cache: z.object({ state: z.enum(["cold", "warm"]) }),
  budgets: z.object({
    duration: budgetSchema,
    artifactSize: budgetSchema,
    cacheSize: budgetSchema,
  }),
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "metrics-dir": { type: "string", default: ".build-metrics" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      [
        "Usage: npm run build:budget-check [-- <options>]",
        "",
        "Grades the budgets recorded by the last `npm run build:measure` run and",
        "exits non-zero if one was blown.",
        "",
        "Options:",
        "  --metrics-dir <dir>  where to read latest.json from (default .build-metrics)",
      ].join("\n"),
    );
    return;
  }

  const metricsPath = path.resolve(ROOT, values["metrics-dir"] ?? ".build-metrics", "latest.json");
  const metrics = metricsSchema.parse(JSON.parse(await readFile(metricsPath, "utf-8")));

  const outcome = decideBuildOutcome({
    buildSucceeded: metrics.success,
    cacheState: metrics.cache.state,
    ci: process.env.CI === "true",
    warnOnly: false,
    durationBudget: metrics.budgets.duration,
    artifactBudget: metrics.budgets.artifactSize,
    cacheBudget: metrics.budgets.cacheSize,
  });

  // Only the breaches that fail the run: everything this decision warns about was
  // already annotated by the measuring step, and annotating it twice per run just
  // makes the run summary harder to read.
  for (const annotation of outcome.annotations.filter((entry) => entry.level === "error")) {
    emitAnnotation(annotation);
  }

  if (outcome.failureMessage) {
    console.error(outcome.failureMessage);
  } else {
    console.log(
      `✅ Build performance budgets met (${path.relative(ROOT, metricsPath)}): ` +
        `duration ${formatPercent(metrics.budgets.duration.ratio)} and output size ` +
        `${formatPercent(metrics.budgets.artifactSize.ratio)} of budget.`,
    );
  }
  process.exitCode = outcome.exitCode;
}

main().catch((error) => {
  console.error(
    "\nBuild budget check failed — could not read the metrics from `npm run build:measure`:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
