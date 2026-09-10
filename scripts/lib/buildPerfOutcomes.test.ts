import { describe, it, expect } from "vitest";
import { detectRegression, evaluateBudget } from "./buildMetrics";
import { decideBuildOutcome, decideTrendOutcome, type StepTrend } from "./buildPerfOutcomes";

const okDuration = evaluateBudget(4_000, 12_000);
const overDuration = evaluateBudget(13_000, 12_000);
const warnDuration = evaluateBudget(11_000, 12_000);
const okArtifact = evaluateBudget(11_000_000, 26_214_400);
const overArtifact = evaluateBudget(30_000_000, 26_214_400);
const okCache = evaluateBudget(45_000_000, 268_435_456);
const overCache = evaluateBudget(300_000_000, 268_435_456);

function buildInput(overrides: Partial<Parameters<typeof decideBuildOutcome>[0]> = {}) {
  return {
    buildSucceeded: true,
    cacheState: "warm" as const,
    ci: true,
    warnOnly: false,
    durationBudget: okDuration,
    artifactBudget: okArtifact,
    cacheBudget: okCache,
    ...overrides,
  };
}

describe("decideBuildOutcome", () => {
  it("says nothing when everything is within budget", () => {
    expect(decideBuildOutcome(buildInput())).toEqual({
      annotations: [],
      exitCode: 0,
      failureMessage: null,
    });
  });

  it("fails the run on a duration breach, as an error annotation", () => {
    const outcome = decideBuildOutcome(buildInput({ durationBudget: overDuration }));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.failureMessage).toMatch(/build-perf\.config\.json/);
    expect(outcome.annotations).toEqual([
      {
        level: "error",
        title: "Build duration",
        message: "13.0s vs 12.0s budget (warm cache) — 108.3% of budget",
      },
    ]);
  });

  it("downgrades the same breach to a warning in --warn-only mode", () => {
    const outcome = decideBuildOutcome(
      buildInput({ durationBudget: overDuration, warnOnly: true }),
    );
    expect(outcome).toMatchObject({ exitCode: 0, failureMessage: null });
    expect(outcome.annotations).toHaveLength(1);
    expect(outcome.annotations[0].level).toBe("warning");
  });

  it("warns without failing when a measurement is merely close to its budget", () => {
    const outcome = decideBuildOutcome(buildInput({ durationBudget: warnDuration }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.annotations).toEqual([
      expect.objectContaining({ level: "warning", title: "Build duration" }),
    ]);
  });

  it("reports the output-size budget too", () => {
    const outcome = decideBuildOutcome(buildInput({ artifactBudget: overArtifact }));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.annotations).toEqual([
      {
        level: "error",
        title: "Build output size",
        message: "28.6 MB vs 25.0 MB budget — 114.4% of budget",
      },
    ]);
  });

  it("warns about a cold cache in CI, since it is graded against the looser budget", () => {
    const outcome = decideBuildOutcome(buildInput({ cacheState: "cold" }));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.annotations).toEqual([
      expect.objectContaining({ level: "warning", title: "Cold build cache" }),
    ]);
    expect(outcome.annotations[0].message).toContain("Restore Next.js build cache");
  });

  it("keeps quiet about a cold cache outside CI, where it is normal", () => {
    expect(decideBuildOutcome(buildInput({ cacheState: "cold", ci: false })).annotations).toEqual(
      [],
    );
  });

  it("warns about an oversized Turbopack cache but never fails on it", () => {
    const outcome = decideBuildOutcome(buildInput({ cacheBudget: overCache }));
    expect(outcome).toMatchObject({ exitCode: 0, failureMessage: null });
    expect(outcome.annotations).toEqual([
      expect.objectContaining({ level: "warning", title: "Turbopack cache size" }),
    ]);
  });

  it("does not grade budgets when the build itself failed", () => {
    const outcome = decideBuildOutcome(
      buildInput({ buildSucceeded: false, durationBudget: overDuration, cacheState: "cold" }),
    );
    // The build's own failure is what matters; only the cold-cache note survives.
    expect(outcome.annotations.map((annotation) => annotation.title)).toEqual([
      "Cold build cache",
    ]);
    expect(outcome).toMatchObject({ exitCode: 0, failureMessage: null });
  });
});

const regressedStep: StepTrend = {
  step: "Build",
  currentMs: 10_400,
  baseline: { count: 5, min: 3_000, p50: 3_900, p90: 4_200, max: 4_500, mean: 3_800 },
  regression: detectRegression({
    current: 10_400,
    baseline: 3_900,
    ratioThreshold: 1.5,
    minDelta: 2_500,
  }),
};

const healthyStep: StepTrend = {
  step: "Lint",
  currentMs: 4_000,
  baseline: { count: 5, min: 3_000, p50: 4_000, p90: 4_200, max: 4_500, mean: 3_900 },
  regression: detectRegression({
    current: 4_000,
    baseline: 4_000,
    ratioThreshold: 1.5,
    minDelta: 2_500,
  }),
};

const trackedSteps = ["Build", "Lint", "E2E tests"];

describe("decideTrendOutcome", () => {
  it("says nothing when every tracked step was measured and none regressed", () => {
    expect(
      decideTrendOutcome({
        steps: [healthyStep],
        trackedSteps,
        baselineFetchFailures: 0,
        baselineRuns: 5,
        failOnRegression: false,
      }),
    ).toEqual({ annotations: [], exitCode: 0 });
  });

  it("warns about a regression without failing by default", () => {
    const outcome = decideTrendOutcome({
      steps: [regressedStep, healthyStep],
      trackedSteps,
      baselineFetchFailures: 0,
      baselineRuns: 5,
      failOnRegression: false,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.annotations).toEqual([
      {
        level: "warning",
        title: "Build timing regression: Build",
        message: "10.4s vs 3.9s baseline p50 (+6.5s, 2.67x)",
      },
    ]);
  });

  it("escalates to an error and exit 1 with --fail-on-regression", () => {
    const outcome = decideTrendOutcome({
      steps: [regressedStep],
      trackedSteps,
      baselineFetchFailures: 0,
      baselineRuns: 5,
      failOnRegression: true,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.annotations[0].level).toBe("error");
  });

  it("warns when a tracked step was not measured at all", () => {
    // The silent-degradation case: a renamed CI step reports "n/a" forever.
    const outcome = decideTrendOutcome({
      steps: [healthyStep, { step: "E2E tests", currentMs: null, baseline: null, regression: null }],
      trackedSteps,
      baselineFetchFailures: 0,
      baselineRuns: 5,
      failOnRegression: false,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.annotations).toEqual([
      expect.objectContaining({ level: "warning", title: "Tracked step not measured" }),
    ]);
    expect(outcome.annotations[0].message).toContain("E2E tests");
    expect(outcome.annotations[0].message).toContain("ci.yml");
  });

  it("ignores an unmeasured row that is not a tracked step", () => {
    // "Total job" is synthesized by the report, not a step name from ci.yml.
    expect(
      decideTrendOutcome({
        steps: [{ step: "Total job", currentMs: null, baseline: null, regression: null }],
        trackedSteps,
        baselineFetchFailures: 0,
        baselineRuns: 5,
        failOnRegression: false,
      }).annotations,
    ).toEqual([]);
  });

  it("surfaces a baseline that came back short because fetches failed", () => {
    const outcome = decideTrendOutcome({
      steps: [healthyStep],
      trackedSteps,
      baselineFetchFailures: 4,
      baselineRuns: 2,
      failOnRegression: false,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.annotations).toEqual([
      expect.objectContaining({ level: "warning", title: "Incomplete timing baseline" }),
    ]);
    expect(outcome.annotations[0].message).toMatch(/4 baseline run\(s\).*uses 2 run\(s\)/);
  });
});
