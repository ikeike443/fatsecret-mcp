import { describe, it, expect } from "vitest";
import {
  detectRegression,
  durationMs,
  evaluateBudget,
  formatBytes,
  formatDuration,
  formatPercent,
  formatSignedDuration,
  jobDurationMs,
  parseTraceSpans,
  percentile,
  renderMarkdownTable,
  statusIcon,
  stepDurationsMs,
  summarizeBuildPhases,
  summarizeDurations,
} from "./buildMetrics";

// Two lines of a real `.next/trace-build` (durations are microseconds), trimmed
// to the spans this repo's build actually emits.
const TRACE_BUILD = [
  JSON.stringify([
    { name: "run-turbopack", duration: 567978, timestamp: 68526483686, id: 14, parentId: 1, tags: {} },
    { name: "run-typescript", duration: 1871152, timestamp: 68527055524, id: 16, parentId: 1, tags: {} },
    { name: "static-generation", duration: 660559, timestamp: 68529815818, id: 39, parentId: 1, tags: {} },
  ]),
  JSON.stringify([
    {
      name: "next-build",
      duration: 4239006,
      timestamp: 68526383582,
      id: 1,
      tags: { version: "16.3.0", bundler: "turbopack" },
    },
  ]),
].join("\n");

describe("parseTraceSpans", () => {
  it("parses Next.js' newline-separated arrays of spans", () => {
    const spans = parseTraceSpans(TRACE_BUILD);
    expect(spans.map((span) => span.name)).toEqual([
      "run-turbopack",
      "run-typescript",
      "static-generation",
      "next-build",
    ]);
  });

  it("skips blank and malformed lines instead of throwing", () => {
    const spans = parseTraceSpans(
      ["", "   ", "not json at all", '{"name":"clean","duration":7819,"id":7,"parentId":1}'].join("\n"),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ name: "clean", duration: 7819 });
  });

  it("ignores entries that are not spans", () => {
    expect(parseTraceSpans('[{"name":"x"},null,42,{"duration":1,"id":2}]')).toEqual([]);
  });
});

describe("summarizeBuildPhases", () => {
  it("converts the root span to ms and aggregates its direct children", () => {
    const summary = summarizeBuildPhases(parseTraceSpans(TRACE_BUILD));

    expect(summary.totalMs).toBeCloseTo(4239.006, 3);
    expect(summary.rootTags).toMatchObject({ bundler: "turbopack" });
    // Sorted slowest-first, which is what the CI summary shows.
    expect(summary.phases.map((phase) => phase.name)).toEqual([
      "run-typescript",
      "static-generation",
      "run-turbopack",
    ]);
    expect(summary.phases[0].durationMs).toBeCloseTo(1871.152, 3);
    expect(summary.phases[0].share).toBeCloseTo(1871152 / 4239006, 6);
  });

  it("sums distinct spans that share a name, and ignores grandchildren", () => {
    const spans = parseTraceSpans(
      JSON.stringify([
        { name: "next-build", duration: 4000, id: 1 },
        { name: "write-routes-manifest", duration: 1000, id: 2, parentId: 1 },
        { name: "write-routes-manifest", duration: 500, id: 3, parentId: 1 },
        { name: "nested", duration: 900, id: 4, parentId: 2 },
      ]),
    );
    const summary = summarizeBuildPhases(spans);
    expect(summary.phases).toEqual([
      { name: "write-routes-manifest", durationMs: 1.5, share: 0.375 },
    ]);
  });

  it("deduplicates by span id — Next.js writes top-level phases to both trace files", () => {
    // `.next/trace-build` and `.next/trace` both contain span id 16; counting it
    // twice inflated `run-typescript` to ~100% of the build.
    const duplicated = parseTraceSpans([TRACE_BUILD, TRACE_BUILD].join("\n"));
    const summary = summarizeBuildPhases(duplicated);

    expect(duplicated).toHaveLength(8);
    expect(summary.phases).toHaveLength(3);
    expect(summary.phases[0]).toMatchObject({ name: "run-typescript" });
    expect(summary.phases[0].durationMs).toBeCloseTo(1871.152, 3);
  });

  it("reports nothing when the build was not traced", () => {
    expect(summarizeBuildPhases([])).toEqual({ totalMs: null, phases: [], rootTags: {} });
  });
});

describe("evaluateBudget", () => {
  it("passes comfortably under budget", () => {
    const result = evaluateBudget(4_700, 30_000, 0.85);
    expect(result.status).toBe("ok");
    expect(result.ratio).toBeCloseTo(0.157, 3);
    expect(result.delta).toBe(-25_300);
  });

  it("warns once the measurement crosses the warn ratio", () => {
    expect(evaluateBudget(25_500, 30_000, 0.85).status).toBe("warn");
    expect(evaluateBudget(25_499, 30_000, 0.85).status).toBe("ok");
  });

  it("fails only above the budget itself", () => {
    expect(evaluateBudget(30_000, 30_000).status).toBe("warn");
    expect(evaluateBudget(30_001, 30_000).status).toBe("over");
  });

  it("rejects nonsensical inputs", () => {
    expect(() => evaluateBudget(-1, 100)).toThrow(/non-negative/);
    expect(() => evaluateBudget(1, 0)).toThrow(/positive/);
    expect(() => evaluateBudget(1, 100, 0)).toThrow(/warnRatio/);
    expect(() => evaluateBudget(1, 100, 1.2)).toThrow(/warnRatio/);
  });
});

describe("percentile / summarizeDurations", () => {
  it("interpolates between samples", () => {
    const values = [10, 20, 30, 40];
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 0.5)).toBe(25);
    expect(percentile(values, 1)).toBe(40);
    expect(percentile(values, 0.9)).toBeCloseTo(37, 6);
  });

  it("does not care about input order and leaves the input untouched", () => {
    const values = [30, 10, 20];
    expect(percentile(values, 0.5)).toBe(20);
    expect(values).toEqual([30, 10, 20]);
  });

  it("summarizes a run history", () => {
    const stats = summarizeDurations([9_000, 10_000, 11_000, 30_000]);
    expect(stats).toMatchObject({ count: 4, min: 9_000, p50: 10_500, max: 30_000, mean: 15_000 });
    expect(stats.p90).toBeCloseTo(24_300, 6);
  });

  it("refuses empty input rather than reporting NaN", () => {
    expect(() => percentile([], 0.5)).toThrow(/at least one value/);
    expect(() => summarizeDurations([])).toThrow(/at least one value/);
    expect(() => percentile([1], 1.5)).toThrow(/0\.\.1/);
  });
});

describe("detectRegression", () => {
  const thresholds = { ratioThreshold: 1.5, minDelta: 15_000 };

  it("flags a step that is both relatively and absolutely slower", () => {
    const check = detectRegression({ current: 60_000, baseline: 20_000, ...thresholds });
    expect(check.regressed).toBe(true);
    expect(check.ratio).toBe(3);
    expect(check.delta).toBe(40_000);
  });

  it("ignores a big ratio on a fast step (runner noise, not a regression)", () => {
    const check = detectRegression({ current: 900, baseline: 300, ...thresholds });
    expect(check.ratio).toBe(3);
    expect(check.regressed).toBe(false);
  });

  it("ignores a big absolute delta that is still within the ratio", () => {
    expect(
      detectRegression({ current: 119_000, baseline: 100_000, ...thresholds }).regressed,
    ).toBe(false);
  });

  it("treats a faster run as no regression", () => {
    const check = detectRegression({ current: 5_000, baseline: 20_000, ...thresholds });
    expect(check.regressed).toBe(false);
    expect(check.delta).toBe(-15_000);
  });

  it("handles a zero baseline without producing Infinity in the report", () => {
    const check = detectRegression({ current: 20_000, baseline: 0, ...thresholds });
    expect(check.ratio).toBeNull();
    expect(check.regressed).toBe(true);
    expect(JSON.parse(JSON.stringify(check)).ratio).toBeNull();
  });

  it("validates its thresholds", () => {
    expect(() => detectRegression({ current: 1, baseline: 1, ratioThreshold: 1, minDelta: 0 })).toThrow(
      /ratioThreshold/,
    );
    expect(() =>
      detectRegression({ current: 1, baseline: 1, ratioThreshold: 1.5, minDelta: -1 }),
    ).toThrow(/minDelta/);
  });
});

describe("durationMs / stepDurationsMs / jobDurationMs", () => {
  const job = {
    name: "test",
    started_at: "2026-08-22T05:46:14Z",
    completed_at: "2026-08-22T05:46:49Z",
    steps: [
      { name: "Install dependencies", started_at: "2026-08-22T05:46:18Z", completed_at: "2026-08-22T05:46:27Z" },
      { name: "Build", started_at: "2026-08-22T05:46:36Z", completed_at: "2026-08-22T05:46:46Z" },
      { name: "Skipped step", started_at: null, completed_at: null },
    ],
  };

  it("extracts step and job durations from the GitHub Actions payload", () => {
    expect(stepDurationsMs(job)).toEqual({ "Install dependencies": 9_000, Build: 10_000 });
    expect(jobDurationMs(job)).toBe(35_000);
  });

  it("sums a step name that ran more than once", () => {
    expect(
      stepDurationsMs({
        name: "test",
        steps: [
          { name: "Build", started_at: "2026-08-22T05:00:00Z", completed_at: "2026-08-22T05:00:10Z" },
          { name: "Build", started_at: "2026-08-22T05:00:20Z", completed_at: "2026-08-22T05:00:25Z" },
        ],
      }),
    ).toEqual({ Build: 15_000 });
  });

  it("returns null for missing, unparseable or reversed timestamps", () => {
    expect(durationMs(null, "2026-08-22T05:46:49Z")).toBeNull();
    expect(durationMs("2026-08-22T05:46:14Z", undefined)).toBeNull();
    expect(durationMs("not-a-date", "2026-08-22T05:46:49Z")).toBeNull();
    expect(durationMs("2026-08-22T05:46:49Z", "2026-08-22T05:46:14Z")).toBeNull();
    expect(jobDurationMs({ name: "test" })).toBeNull();
  });
});

describe("formatting", () => {
  it("formats durations at the precision each magnitude deserves", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(412.6)).toBe("413ms");
    expect(formatDuration(4_740)).toBe("4.7s");
    expect(formatDuration(59_949)).toBe("59.9s");
    expect(formatDuration(63_000)).toBe("1m 03s");
    expect(formatDuration(Number.NaN)).toBe("n/a");
  });

  it("always signs deltas", () => {
    expect(formatSignedDuration(2_100)).toBe("+2.1s");
    expect(formatSignedDuration(-400)).toBe("-400ms");
    expect(formatSignedDuration(0)).toBe("±0ms");
  });

  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_536)).toBe("1.5 KB");
    expect(formatBytes(26_214_400)).toBe("25.0 MB");
    expect(formatBytes(-1_048_576)).toBe("-1.0 MB");
  });

  it("formats shares and statuses", () => {
    expect(formatPercent(0.1571)).toBe("15.7%");
    expect(formatPercent(null)).toBe("n/a");
    expect([statusIcon("ok"), statusIcon("warn"), statusIcon("over")]).toEqual(["✅", "⚠️", "❌"]);
  });
});

describe("renderMarkdownTable", () => {
  it("renders a GitHub-flavoured table", () => {
    expect(renderMarkdownTable(["Step", "Duration"], [["Build", "4.7s"]])).toBe(
      ["| Step | Duration |", "| --- | --- |", "| Build | 4.7s |"].join("\n"),
    );
  });

  it("escapes pipes so a cell cannot break the table", () => {
    expect(renderMarkdownTable(["Cmd"], [["a | b"]])).toContain("| a \\| b |");
  });

  it("rejects rows that do not match the header width", () => {
    expect(() => renderMarkdownTable(["A", "B"], [["only-one"]])).toThrow(/row 0 has 1 cells/);
    expect(() => renderMarkdownTable([], [])).toThrow(/at least one column/);
  });
});
