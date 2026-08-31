// The two GitHub Actions output channels the build-performance scripts use:
// annotations and the run's step summary. Kept apart from the pure helpers in
// buildMetrics.ts / buildPerfOutcomes.ts because these write to stdout and the
// filesystem, and shared so all three CLIs annotate the same way.
import { appendFile } from "node:fs/promises";
import type { Annotation } from "./buildPerfOutcomes";

/**
 * Emits a workflow-command annotation in CI, or a plain line locally. Messages
 * must stay single-line: a newline ends the workflow command, so the rest of the
 * message would be printed as ordinary log output instead of annotated.
 */
export function emitAnnotation(annotation: Annotation): void {
  const { level, title, message } = annotation;
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::${level} title=${title}::${message}`);
  } else {
    console.log(`${level === "error" ? "ERROR" : "WARN"}: ${title} — ${message}`);
  }
}

/** Appends Markdown to the job summary, or does nothing outside Actions. */
export async function appendStepSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  await appendFile(summaryPath, `${markdown}\n\n`);
}
