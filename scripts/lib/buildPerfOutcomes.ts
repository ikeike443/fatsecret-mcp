// The decision logic of the two build-performance CLIs: given a set of
// measurements, what gets annotated, at which level, and does the process exit
// non-zero? Pure and separate from the scripts themselves, because this is the
// part that actually gates CI — testing it must not require running a build or
// calling the GitHub API.
import {
  formatBytes,
  formatDuration,
  formatPercent,
  formatSignedDuration,
  type BudgetEvaluation,
  type DurationStats,
  type RegressionCheck,
} from "./buildMetrics";

/** A GitHub Actions annotation (`::warning`/`::error`), or a console line locally. */
export interface Annotation {
  level: "warning" | "error";
  title: string;
  message: string;
}

export interface BuildOutcomeInput {
  /** `false` when `next build` itself failed; budgets are not graded then. */
  buildSucceeded: boolean;
  cacheState: "cold" | "warm";
  /** In CI a cold cache means the restore step did not do its job. */
  ci: boolean;
  /** Report a breach without failing the run. */
  warnOnly: boolean;
  durationBudget: BudgetEvaluation;
  artifactBudget: BudgetEvaluation;
  cacheBudget: BudgetEvaluation;
}

export interface BuildOutcome {
  annotations: Annotation[];
  exitCode: 0 | 1;
  /** Printed before exiting non-zero; `null` when nothing was breached. */
  failureMessage: string | null;
}

const BUDGET_FAILURE_MESSAGE =
  "Build performance budget exceeded. Either optimize the build or raise the " +
  "budget in build-perf.config.json deliberately (see README's 'Build performance').";

/**
 * Grades a measured build. Only the duration and output-size budgets can fail a
 * run; a cold cache or an oversized Turbopack cache are CI-environment problems,
 * so they warn.
 */
export function decideBuildOutcome(input: BuildOutcomeInput): BuildOutcome {
  const annotations: Annotation[] = [];

  if (input.ci && input.cacheState === "cold") {
    // Without this, a broken cache restore is *rewarded*: the build loses the
    // warm speedup but gets graded against the looser cold budget instead.
    annotations.push({
      level: "warning",
      title: "Cold build cache",
      message:
        `.next/cache was not restored, so this build is graded against the cold budget ` +
        `(${formatDuration(input.durationBudget.budget)} instead of the warm one). Expected right ` +
        `after a lockfile or source change; otherwise check the "Restore Next.js build cache" step.`,
    });
  }

  if (!input.buildSucceeded) {
    return { annotations, exitCode: 0, failureMessage: null };
  }

  const graded = [
    { title: "Build duration", budget: input.durationBudget, unit: "duration" },
    { title: "Build output size", budget: input.artifactBudget, unit: "bytes" },
  ] as const;
  for (const { title, budget, unit } of graded) {
    if (budget.status === "ok") continue;
    annotations.push({
      // In --warn-only mode the breach does not fail the run, so it is annotated
      // as a warning rather than claiming an error that never happened.
      level: budget.status === "over" && !input.warnOnly ? "error" : "warning",
      title,
      message: describeBudget(budget, { unit, cacheState: unit === "duration" ? input.cacheState : undefined }),
    });
  }

  if (input.cacheBudget.status !== "ok") {
    annotations.push({
      level: "warning",
      title: "Turbopack cache size",
      message:
        `${describeBudget(input.cacheBudget, { unit: "bytes" })} — the CI cache only ever grows; ` +
        `bump the cache key prefix in .github/workflows/ci.yml to start it over.`,
    });
  }

  const breached =
    input.durationBudget.status === "over" || input.artifactBudget.status === "over";
  return breached && !input.warnOnly
    ? { annotations, exitCode: 1, failureMessage: BUDGET_FAILURE_MESSAGE }
    : { annotations, exitCode: 0, failureMessage: null };
}

function describeBudget(
  budget: BudgetEvaluation,
  options: { unit: "duration" | "bytes"; cacheState?: string },
): string {
  const format = options.unit === "duration" ? formatDuration : formatBytes;
  const suffix = options.cacheState ? ` (${options.cacheState} cache)` : "";
  return (
    `${format(budget.actual)} vs ${format(budget.budget)} budget${suffix} — ` +
    `${formatPercent(budget.ratio)} of budget`
  );
}

/** One tracked CI step, compared against the baseline history. */
export interface StepTrend {
  step: string;
  currentMs: number | null;
  baseline: DurationStats | null;
  regression: RegressionCheck | null;
}

export interface TrendOutcomeInput {
  steps: readonly StepTrend[];
  /** `trend.trackedSteps` from the config — the synthetic total is not one. */
  trackedSteps: readonly string[];
  /** Baseline runs whose job could not be fetched from the API. */
  baselineFetchFailures: number;
  /** Baseline runs that were usable. */
  baselineRuns: number;
  failOnRegression: boolean;
}

export interface TrendOutcome {
  annotations: Annotation[];
  exitCode: 0 | 1;
}

/**
 * Turns a timing-trend report into annotations. Besides regressions, this is
 * where the two ways the report can quietly measure nothing get surfaced: a
 * tracked step that no longer exists under that name in `ci.yml`, and a baseline
 * that came back short because API calls failed.
 */
export function decideTrendOutcome(input: TrendOutcomeInput): TrendOutcome {
  const annotations: Annotation[] = [];

  for (const step of input.steps) {
    if (!step.regression?.regressed) continue;
    annotations.push({
      level: input.failOnRegression ? "error" : "warning",
      title: `Build timing regression: ${step.step}`,
      message:
        `${formatDuration(step.regression.current)} vs ${formatDuration(step.regression.baseline)} ` +
        `baseline p50 (${formatSignedDuration(step.regression.delta)}, ` +
        `${step.regression.ratio?.toFixed(2) ?? "?"}x)`,
    });
  }

  const unmeasured = input.steps
    .filter((step) => step.currentMs === null && input.trackedSteps.includes(step.step))
    .map((step) => step.step);
  if (unmeasured.length > 0) {
    annotations.push({
      level: "warning",
      title: "Tracked step not measured",
      message:
        `${unmeasured.join(", ")} — trend.trackedSteps in build-perf.config.json no longer matches ` +
        `the step names in .github/workflows/ci.yml, so these steps are not being tracked at all.`,
    });
  }

  if (input.baselineFetchFailures > 0) {
    annotations.push({
      level: "warning",
      title: "Incomplete timing baseline",
      message:
        `${input.baselineFetchFailures} baseline run(s) could not be fetched from the GitHub API; ` +
        `the comparison uses ${input.baselineRuns} run(s) and may be less reliable than usual.`,
    });
  }

  const regressed = input.steps.some((step) => step.regression?.regressed);
  return { annotations, exitCode: regressed && input.failOnRegression ? 1 : 0 };
}
