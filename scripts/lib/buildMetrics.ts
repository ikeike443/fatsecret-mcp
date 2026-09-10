// Pure helpers shared by the build-performance scripts:
//   - scripts/measure-build.ts     (times `next build`, checks it against a budget)
//   - scripts/build-perf-report.ts (compares CI step timings against history)
// Everything here is side-effect free so it can be unit tested without running
// a build or talking to the GitHub API.

/** A single span from Next.js' build trace (`.next/trace`, `.next/trace-build`). */
export interface TraceSpan {
  name: string;
  /** Span duration in **microseconds** — that is what Next.js writes. */
  duration: number;
  id: number;
  parentId?: number;
  timestamp?: number;
  startTime?: number;
  tags?: Record<string, string | number | boolean | null>;
}

export interface BuildPhase {
  name: string;
  durationMs: number;
  /** Fraction of the root span this phase accounts for, or `null` if unknown. */
  share: number | null;
}

export interface BuildPhaseSummary {
  /** Duration of the root (`next-build`) span in ms, or `null` if not traced. */
  totalMs: number | null;
  phases: BuildPhase[];
  /** Tags of the root span (Next.js version, bundler, build mode, ...). */
  rootTags: Record<string, string | number | boolean | null>;
}

export type BudgetStatus = "ok" | "warn" | "over";

export interface BudgetEvaluation {
  actual: number;
  budget: number;
  /** `actual / budget`. */
  ratio: number;
  /** `actual - budget`; negative means under budget. */
  delta: number;
  status: BudgetStatus;
  warnRatio: number;
}

export interface DurationStats {
  count: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
  mean: number;
}

export interface RegressionCheck {
  current: number;
  baseline: number;
  delta: number;
  /** `current / baseline`, or `null` when the baseline is 0 (ratio undefined). */
  ratio: number | null;
  regressed: boolean;
  ratioThreshold: number;
  minDelta: number;
}

/** Shape of the bits of the GitHub Actions "jobs for a run" payload we use. */
export interface WorkflowJobStep {
  name: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface WorkflowJob {
  name: string;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: WorkflowJobStep[] | null;
}

/**
 * Parses a Next.js trace file. The format is one JSON array of spans per
 * flush, newline-separated, so the file as a whole is not valid JSON. Malformed
 * lines are skipped rather than failing the build we just measured.
 */
export function parseTraceSpans(contents: string): TraceSpan[] {
  const spans: TraceSpan[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isTraceSpan(candidate)) spans.push(candidate);
    }
  }
  return spans;
}

function isTraceSpan(value: unknown): value is TraceSpan {
  if (typeof value !== "object" || value === null) return false;
  const span = value as Record<string, unknown>;
  return (
    typeof span.name === "string" &&
    typeof span.duration === "number" &&
    Number.isFinite(span.duration) &&
    typeof span.id === "number"
  );
}

/**
 * Aggregates the direct children of the root build span into per-phase
 * durations (`run-turbopack`, `run-typescript`, `static-generation`, ...), so a
 * slowdown can be attributed to a phase instead of just "the build".
 *
 * Spans are deduplicated by id because Next.js writes the top-level phases to
 * both `.next/trace-build` and `.next/trace`; a name that legitimately occurs
 * twice (two spans, two ids) is summed. Phase durations can overlap — Turbopack
 * compilation and type checking run concurrently — so shares need not add up to
 * 100%.
 */
export function summarizeBuildPhases(
  spans: readonly TraceSpan[],
  rootSpanName = "next-build",
): BuildPhaseSummary {
  const root = spans.find((span) => span.name === rootSpanName);
  if (!root) return { totalMs: null, phases: [], rootTags: {} };

  const totalMs = root.duration / 1000;
  const byName = new Map<string, number>();
  const seenIds = new Set<number>();
  for (const span of spans) {
    if (span.parentId !== root.id) continue;
    if (seenIds.has(span.id)) continue;
    seenIds.add(span.id);
    byName.set(span.name, (byName.get(span.name) ?? 0) + span.duration / 1000);
  }

  const phases = [...byName.entries()]
    .map(([name, durationMs]) => ({
      name,
      durationMs,
      share: totalMs > 0 ? durationMs / totalMs : null,
    }))
    .sort((a, b) => b.durationMs - a.durationMs);

  return { totalMs, phases, rootTags: root.tags ?? {} };
}

/**
 * Grades a measurement against a budget. `warnRatio` is the fraction of the
 * budget at which the result is still passing but worth flagging, so budgets
 * get raised (or the build gets optimized) deliberately instead of after a
 * surprise CI failure.
 */
export function evaluateBudget(
  actual: number,
  budget: number,
  warnRatio = 0.85,
): BudgetEvaluation {
  if (!Number.isFinite(actual) || actual < 0) {
    throw new Error(`evaluateBudget: actual must be a non-negative number, got ${actual}`);
  }
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`evaluateBudget: budget must be a positive number, got ${budget}`);
  }
  if (!(warnRatio > 0 && warnRatio <= 1)) {
    throw new Error(`evaluateBudget: warnRatio must be within (0, 1], got ${warnRatio}`);
  }

  const ratio = actual / budget;
  const status: BudgetStatus = ratio > 1 ? "over" : ratio >= warnRatio ? "warn" : "ok";
  return { actual, budget, ratio, delta: actual - budget, status, warnRatio };
}

/** Linear-interpolated percentile. `fraction` is 0..1 (0.5 = median). */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    throw new Error("percentile: needs at least one value");
  }
  if (!(fraction >= 0 && fraction <= 1)) {
    throw new Error(`percentile: fraction must be within 0..1, got ${fraction}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = fraction * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export function summarizeDurations(values: readonly number[]): DurationStats {
  if (values.length === 0) {
    throw new Error("summarizeDurations: needs at least one value");
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: Math.max(...values),
    mean: sum / values.length,
  };
}

/**
 * Flags a regression only when the measurement is both relatively *and*
 * absolutely worse than the baseline — a 2x slowdown on a 200ms step is runner
 * noise, not a regression worth interrupting anyone for.
 */
export function detectRegression(input: {
  current: number;
  baseline: number;
  ratioThreshold: number;
  minDelta: number;
}): RegressionCheck {
  const { current, baseline, ratioThreshold, minDelta } = input;
  if (!(ratioThreshold > 1)) {
    throw new Error(`detectRegression: ratioThreshold must be > 1, got ${ratioThreshold}`);
  }
  if (minDelta < 0) {
    throw new Error(`detectRegression: minDelta must be >= 0, got ${minDelta}`);
  }

  const delta = current - baseline;
  const ratio = baseline > 0 ? current / baseline : null;
  const relativelyWorse = ratio === null ? delta > 0 : ratio >= ratioThreshold;
  return {
    current,
    baseline,
    delta,
    ratio,
    regressed: relativelyWorse && delta >= minDelta,
    ratioThreshold,
    minDelta,
  };
}

/** Elapsed milliseconds between two ISO timestamps, or `null` if unusable. */
export function durationMs(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/**
 * Per-step durations for one GitHub Actions job. Steps without usable
 * timestamps (skipped, still running) are omitted; a name that appears more
 * than once is summed, since that is the same logical work running twice.
 *
 * A `Map` rather than an object because the keys are arbitrary step names from
 * the API: a step called `__proto__` or `constructor` would otherwise read back
 * as something other than its duration.
 */
export function stepDurationsMs(job: WorkflowJob): Map<string, number> {
  const durations = new Map<string, number>();
  for (const step of job.steps ?? []) {
    const ms = durationMs(step.started_at, step.completed_at);
    if (ms === null) continue;
    durations.set(step.name, (durations.get(step.name) ?? 0) + ms);
  }
  return durations;
}

export function jobDurationMs(job: WorkflowJob): number | null {
  return durationMs(job.started_at, job.completed_at);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "n/a";
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(abs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${ms < 0 ? "-" : ""}${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Same as {@link formatDuration} but always carries an explicit sign. */
export function formatSignedDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "n/a";
  const formatted = formatDuration(Math.abs(ms));
  if (Math.round(ms) === 0) return `±${formatted}`;
  return `${ms > 0 ? "+" : "-"}${formatted}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "n/a";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${sign}${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function formatPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return "n/a";
  return `${(fraction * 100).toFixed(1)}%`;
}

export function statusIcon(status: BudgetStatus): string {
  return status === "ok" ? "✅" : status === "warn" ? "⚠️" : "❌";
}

/** Renders a GitHub-flavoured Markdown table (used for CI step summaries). */
export function renderMarkdownTable(
  headers: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string {
  if (headers.length === 0) {
    throw new Error("renderMarkdownTable: needs at least one column");
  }
  const escape = (cell: string | number) => String(cell).replaceAll("|", "\\|");
  const lines = [
    `| ${headers.map(escape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const [index, row] of rows.entries()) {
    if (row.length !== headers.length) {
      throw new Error(
        `renderMarkdownTable: row ${index} has ${row.length} cells, expected ${headers.length}`,
      );
    }
    lines.push(`| ${row.map(escape).join(" | ")} |`);
  }
  return lines.join("\n");
}
