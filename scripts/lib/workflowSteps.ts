// Reads the step names of one job out of a GitHub Actions workflow file, so the
// documented coupling between `trend.trackedSteps` in build-perf.config.json and
// the step names in .github/workflows/ci.yml can be asserted in a unit test
// instead of only being noticed as an "n/a" column in a CI report.
//
// Deliberately a hand-rolled reader of the small YAML subset these workflow
// files use (block mappings, block sequences, no anchors, no flow collections)
// rather than a new dependency for a single test.

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Names of the steps of `jobName`, in order. Steps with no `name:` (bare
 * `uses:`) are skipped, since GitHub names those after the action. Throws when
 * the job or its `steps:` block is missing, so a renamed job fails the test that
 * calls this rather than silently returning nothing.
 */
export function workflowStepNames(workflowYaml: string, jobName: string): string[] {
  // Comments and blank lines cannot hold a step name and would confuse the
  // indentation tracking below.
  const lines = workflowYaml
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));

  const jobsIndex = lines.findIndex((line) => line.trimEnd() === "jobs:");
  if (jobsIndex === -1) throw new Error("workflowStepNames: no `jobs:` block");

  const jobIndent = indentOf(lines[jobsIndex + 1] ?? "");
  let jobIndex = -1;
  for (let i = jobsIndex + 1; i < lines.length; i += 1) {
    const indent = indentOf(lines[i]);
    if (indent < jobIndent) break;
    if (indent === jobIndent && lines[i].trim() === `${jobName}:`) {
      jobIndex = i;
      break;
    }
  }
  if (jobIndex === -1) throw new Error(`workflowStepNames: no job named "${jobName}"`);

  let stepsIndex = -1;
  for (let i = jobIndex + 1; i < lines.length; i += 1) {
    if (indentOf(lines[i]) <= jobIndent) break;
    if (lines[i].trim() === "steps:") {
      stepsIndex = i;
      break;
    }
  }
  if (stepsIndex === -1) throw new Error(`workflowStepNames: job "${jobName}" has no steps`);

  const names: string[] = [];
  const itemIndent = indentOf(lines[stepsIndex + 1] ?? "");
  // Indentation of a step's own keys, learned from the first one. Only those
  // count: `name:` also occurs one level deeper, inside `with:`.
  let keyIndent: number | null = null;
  for (let i = stepsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = indentOf(line);
    if (indent < itemIndent) break;

    let content: string;
    if (indent === itemIndent && line.trimStart().startsWith("- ")) {
      content = line.trimStart().slice(2).trim();
      keyIndent = null;
    } else if (indent > itemIndent) {
      keyIndent ??= indent;
      if (indent !== keyIndent) continue;
      content = line.trim();
    } else {
      continue;
    }

    const match = /^name:\s*(.+?)\s*$/.exec(content);
    if (match) names.push(unquote(match[1]));
  }
  return names;
}

function unquote(value: string): string {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}
