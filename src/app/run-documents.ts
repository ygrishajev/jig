import { designReviewReport } from '../domain/design-review-report.js';
import type { MetricsSummary } from '../domain/metrics.js';
import type { RunState } from '../domain/run-state.js';
import type { RunDocumentContents } from '../ports/run-records.js';
import { formatSummary } from './run-summary.js';

/** The text of each document a run leaves for a person; a document the run lacks has none. */
export function runDocumentContents(state: RunState, metrics: MetricsSummary): RunDocumentContents {
  return {
    'design.md': state.docs?.design,
    'plan.md': state.docs?.plan,
    'design-review.md': designReviewReport(state),
    'PR_DESCRIPTION.md': pullRequestDescription(state, metrics),
  };
}

function pullRequestDescription(state: RunState, metrics: MetricsSummary): string | undefined {
  if (state.prDescription === undefined) return undefined;
  const footer = `<sub>jig run ${state.runId}: ${formatSummary(metrics)}</sub>`;
  return `${state.prDescription}\n\n---\n${footer}\n`;
}
