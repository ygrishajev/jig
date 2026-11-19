import type { CapturedOutput } from '../../domain/diagnostics.js';
import {
  type RunDiagnostics,
  runDiagnostics,
  type VerificationFailureDiagnostic,
} from '../../domain/run-diagnostics.js';
import { type RunState, runStopReason } from '../../domain/run-state.js';

/**
 * The single PR-level comment a draft PR carries: why the run stopped and what is still
 * unresolved, with command output kept verbatim so the file and line references in it survive.
 */
export function findingsCommentBody(state: RunState, revision: string): string {
  const diagnostics = runDiagnostics(state);
  return [
    `Run ${state.runId} stopped as ${state.phase} at ${revision}: ${stuckReason(state)}`,
    ...unresolvedReviewSections(diagnostics),
    ...outstandingGapSection(diagnostics),
    ...verificationFailureSection(diagnostics.lastVerificationFailure),
  ].join('\n\n');
}

/** Why a stuck run stopped, for a run saved before the reason could be told. */
export function stuckReason(state: RunState): string {
  return runStopReason(state) ?? 'The run exhausted its attempts.';
}

function unresolvedReviewSections({ unresolvedReviews }: RunDiagnostics): string[] {
  return unresolvedReviews.map(
    ({ sliceId, feedback }) => `### Unresolved review of slice \`${sliceId}\`\n\n${feedback}`,
  );
}

function outstandingGapSection({ outstandingGaps }: RunDiagnostics): string[] {
  if (outstandingGaps.length === 0) return [];
  return [`### Outstanding gaps\n\n${outstandingGaps.map((gap) => `- ${gap}`).join('\n')}`];
}

function verificationFailureSection(failure: VerificationFailureDiagnostic | undefined): string[] {
  if (!failure) return [];
  const status = failure.current ? 'still failing' : 'passed since';
  const command = failure.command ? `\`${failure.command}\`` : 'The verify command';
  return [
    `### Last verification failure (${status})\n\n${command} failed in ${scopeOf(failure)}.\n\n${outputOf(failure.output)}`,
  ];
}

function scopeOf({ scope }: VerificationFailureDiagnostic): string {
  return scope.kind === 'slice'
    ? `slice \`${scope.sliceId}\``
    : `round ${scope.round} of the final check`;
}

function outputOf(output: CapturedOutput): string {
  if (!output.captured) return 'Its output was not kept by the version of jig that ran it.';
  const lead = output.truncated ? 'The end of its output:' : 'Its output:';
  return `${lead}\n\n${fenced(output.tail)}`;
}

/** Fences `text` with more backticks than any run inside it, so the output cannot close the block. */
function fenced(text: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), ([run]) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}
