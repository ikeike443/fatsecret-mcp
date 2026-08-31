// Loads and validates build-perf.config.json — the single place where this
// repo's build-performance budgets and CI-timing thresholds live, so tuning them
// is a reviewable one-line diff instead of a change buried in a script.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const CONFIG_FILENAME = "build-perf.config.json";

const buildBudgetsSchema = z.object({
  // `next build` with Turbopack reuses .next/cache between runs (Next 16.3
  // enables turbopackFileSystemCacheForBuild by default), so a warm build is
  // much cheaper than a cold one and the two need separate budgets.
  coldBudgetMs: z.number().positive(),
  warmBudgetMs: z.number().positive(),
  /** Fraction of the budget at which a build is reported as "warn". */
  warnRatio: z.number().gt(0).lte(1).default(0.85),
  /** `.next` size (excluding `.next/cache`) budget — guards output bloat. */
  artifactBudgetBytes: z.number().positive(),
  /** `.next/cache` must be at least this big to count the build as warm. */
  warmCacheMinBytes: z.number().nonnegative().default(1024 * 1024),
});

const trendSchema = z.object({
  workflow: z.string().min(1).default("ci.yml"),
  /** Name of the job whose step timings are tracked. */
  job: z.string().min(1).default("test"),
  /** Branch whose successful runs form the baseline. */
  baselineBranch: z.string().min(1).default("main"),
  /** How many recent successful runs to pull for the baseline. */
  historyRuns: z.number().int().min(2).max(100).default(20),
  trackedSteps: z.array(z.string().min(1)).min(1),
  /** Current/baseline ratio at which a step counts as regressed. */
  regressionRatio: z.number().gt(1).default(1.5),
  /** ...but only if it also got at least this much slower in absolute terms. */
  minRegressionDeltaMs: z.number().nonnegative().default(15_000),
});

export const buildPerfConfigSchema = z.object({
  build: buildBudgetsSchema,
  trend: trendSchema,
});

export type BuildPerfConfig = z.infer<typeof buildPerfConfigSchema>;

export function parseBuildPerfConfig(raw: unknown): BuildPerfConfig {
  const result = buildPerfConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid ${CONFIG_FILENAME}:\n${issues}`);
  }
  return result.data;
}

export async function loadBuildPerfConfig(rootDir: string): Promise<BuildPerfConfig> {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  let contents: string;
  try {
    contents = await readFile(configPath, "utf-8");
  } catch (error) {
    throw new Error(`Could not read ${configPath}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${configPath} is not valid JSON`, { cause: error });
  }

  return parseBuildPerfConfig(raw);
}
