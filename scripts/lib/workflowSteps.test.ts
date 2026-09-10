import { describe, it, expect } from "vitest";
import { workflowStepNames } from "./workflowSteps";

const WORKFLOW = [
  "name: CI",
  "",
  "on:",
  "  pull_request:",
  "",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "",
  "      # a comment between steps",
  "      - name: Restore Next.js build cache",
  "        uses: actions/cache@v4",
  "        with:",
  "          path: .next/cache",
  "          key: >-",
  "            ${{ runner.os }}-nextcache-",
  "",
  "      - name: Build",
  "        run: npm run build:measure",
  "",
  "      - name: Upload build metrics",
  "        uses: actions/upload-artifact@v4",
  "        with:",
  "          name: build-metrics",
  "          path: .build-metrics/",
  "",
  "  other-job:",
  "    steps:",
  '      - name: "Quoted name"',
  "        run: true",
  "",
].join("\n");

describe("workflowStepNames", () => {
  it("lists the named steps of one job, in order", () => {
    expect(workflowStepNames(WORKFLOW, "test")).toEqual([
      "Restore Next.js build cache",
      "Build",
      "Upload build metrics",
    ]);
  });

  it("ignores `name:` nested under a step's `with:`", () => {
    // `Upload build metrics` has `with.name: build-metrics`; picking that up would
    // make the subset assertion in buildPerfConfig.test.ts pass on the wrong name.
    expect(workflowStepNames(WORKFLOW, "test")).not.toContain("build-metrics");
  });

  it("stops at the end of the job it was asked about", () => {
    expect(workflowStepNames(WORKFLOW, "test")).not.toContain("Quoted name");
    expect(workflowStepNames(WORKFLOW, "other-job")).toEqual(["Quoted name"]);
  });

  it("fails loudly on a missing job or steps block", () => {
    expect(() => workflowStepNames(WORKFLOW, "nope")).toThrow(/no job named "nope"/);
    expect(() => workflowStepNames("jobs:\n  test:\n    runs-on: x\n", "test")).toThrow(
      /has no steps/,
    );
    expect(() => workflowStepNames("name: CI\n", "test")).toThrow(/no `jobs:` block/);
  });
});
