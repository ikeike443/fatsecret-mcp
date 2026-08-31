import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadBuildPerfConfig, parseBuildPerfConfig } from "./buildPerfConfig";

const minimal = {
  build: { coldBudgetMs: 45_000, warmBudgetMs: 30_000, artifactBudgetBytes: 26_214_400 },
  trend: { trackedSteps: ["Build"] },
};

describe("parseBuildPerfConfig", () => {
  it("fills in the thresholds that have sensible defaults", () => {
    const config = parseBuildPerfConfig(minimal);
    expect(config.build.warnRatio).toBe(0.85);
    expect(config.build.warmCacheMinBytes).toBe(1024 * 1024);
    expect(config.trend).toMatchObject({
      workflow: "ci.yml",
      job: "test",
      baselineBranch: "main",
      historyRuns: 20,
      regressionRatio: 1.5,
      minRegressionDeltaMs: 15_000,
    });
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
    const config = await loadBuildPerfConfig(path.resolve(import.meta.dirname, "..", ".."));

    // A warm build must be graded more strictly than a cold one, or the budgets
    // say nothing about whether the Turbopack cache is actually being reused.
    expect(config.build.warmBudgetMs).toBeLessThan(config.build.coldBudgetMs);
    expect(config.trend.trackedSteps).toContain("Build");
  });

  it("fails loudly when the config file is missing", async () => {
    await expect(loadBuildPerfConfig("/nonexistent-dir-for-tests")).rejects.toThrow(
      /Could not read .*build-perf\.config\.json/,
    );
  });
});
