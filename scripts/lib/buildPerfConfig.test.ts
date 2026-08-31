import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { detectRegression, evaluateBudget } from "./buildMetrics";
import { loadBuildPerfConfig, parseBuildPerfConfig } from "./buildPerfConfig";
import { workflowStepNames } from "./workflowSteps";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const minimal = {
  build: { coldBudgetMs: 45_000, warmBudgetMs: 30_000, artifactBudgetBytes: 26_214_400 },
  trend: { trackedSteps: ["Build"] },
};

describe("parseBuildPerfConfig", () => {
  it("fills in the thresholds that have sensible defaults", () => {
    const config = parseBuildPerfConfig(minimal);
    expect(config.build.warnRatio).toBe(0.85);
    expect(config.build.warmCacheMinBytes).toBe(1024 * 1024);
    expect(config.build.cacheBudgetBytes).toBe(256 * 1024 * 1024);
    expect(config.trend).toMatchObject({
      workflow: "ci.yml",
      job: "test",
      baselineBranch: "main",
      historyRuns: 20,
      regressionRatio: 1.5,
      minRegressionDeltaMs: 2_500,
    });
  });

  it("rejects a baseline larger than the GitHub API will return in one page", () => {
    expect(() =>
      parseBuildPerfConfig({ ...minimal, trend: { ...minimal.trend, historyRuns: 101 } }),
    ).toThrow(/trend\.historyRuns/);
  });

  it("reports every invalid field at once, with its path", () => {
    let message = "";
    try {
      parseBuildPerfConfig({
        build: { coldBudgetMs: 0, warmBudgetMs: 30_000, artifactBudgetBytes: 1, warnRatio: 2 },
        trend: { trackedSteps: [], regressionRatio: 0.5 },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/build\.coldBudgetMs/);
    expect(message).toMatch(/build\.warnRatio/);
    expect(message).toMatch(/trend\.trackedSteps/);
    expect(message).toMatch(/trend\.regressionRatio/);
  });

  it("rejects a config that is missing whole sections", () => {
    expect(() => parseBuildPerfConfig({})).toThrow(/Invalid build-perf\.config\.json/);
    expect(() => parseBuildPerfConfig(null)).toThrow(/Invalid build-perf\.config\.json/);
  });
});

describe("loadBuildPerfConfig", () => {
  it("loads this repo's committed config", async () => {
    const config = await loadBuildPerfConfig(REPO_ROOT);

    // A warm build must be graded more strictly than a cold one, or the budgets
    // say nothing about whether the Turbopack cache is actually being reused.
    expect(config.build.warmBudgetMs).toBeLessThan(config.build.coldBudgetMs);
    expect(config.trend.trackedSteps).toContain("Build");
  });

  it("keeps every tracked step name in sync with the CI workflow", async () => {
    // The trend report looks steps up by name, and a name that no longer exists
    // silently reports "n/a" forever instead of failing — so the coupling
    // between the config and .github/workflows/ci.yml is asserted here.
    const config = await loadBuildPerfConfig(REPO_ROOT);
    const workflowYaml = await readFile(
      path.join(REPO_ROOT, ".github", "workflows", `${config.trend.workflow}`),
      "utf-8",
    );
    const stepNames = workflowStepNames(workflowYaml, config.trend.job);

    expect(stepNames).toEqual(expect.arrayContaining([...config.trend.trackedSteps]));
  });

  it("would flag the cache-restore regression it exists to catch", async () => {
    // The failure mode this tracking is for: .next/cache stops being restored, so
    // the build goes from ~3.9s warm to ~10.4s cold on a GitHub-hosted runner.
    // Neither threshold may be so loose that this passes unnoticed.
    const config = await loadBuildPerfConfig(REPO_ROOT);
    const warmMs = 3_900;
    const coldMs = 10_400;

    const trend = detectRegression({
      current: coldMs,
      baseline: warmMs,
      ratioThreshold: config.trend.regressionRatio,
      minDelta: config.trend.minRegressionDeltaMs,
    });
    expect(trend.regressed).toBe(true);

    // ...and the ordinary warm build still has room for runner variance: a build
    // twice as slow as measured must not fail the budget.
    expect(evaluateBudget(warmMs * 2, config.build.warmBudgetMs).status).not.toBe("over");
    expect(evaluateBudget(coldMs * 2, config.build.coldBudgetMs).status).not.toBe("over");
  });

  it("fails loudly when the config file is missing", async () => {
    await expect(loadBuildPerfConfig("/nonexistent-dir-for-tests")).rejects.toThrow(
      /Could not read .*build-perf\.config\.json/,
    );
  });
});
