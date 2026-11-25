import type { CapturedOutput } from './diagnostics.js';
import type { RunState } from './run-state.js';
import type { Slice } from './slice.js';

/** What an operator needs to understand an unfinished run: only what is still unresolved, and the latest failure. */
export interface RunDiagnostics {
  unresolvedReviews: { sliceId: string; feedback: string; at: number }[];
  outstandingGaps: string[];
  lastVerificationFailure?: VerificationFailureDiagnostic;
}

/** A verification failure as the run reports it: `current` until a later verification passed. */
export interface VerificationFailureDiagnostic {
  scope: VerificationFailureScope;
  command?: string;
  output: CapturedOutput;
  at: number;
  current: boolean;
}

export type VerificationFailureScope =
  { kind: 'slice'; sliceId: string } | { kind: 'finalCheck'; round: number };

export function runDiagnostics(state: RunState): RunDiagnostics {
  return {
    unresolvedReviews: state.slices.flatMap((slice) =>
      slice.rejectedReview ? [{ sliceId: slice.id, ...slice.rejectedReview }] : [],
    ),
    outstandingGaps: state.finalCheck?.fulfilled === false ? state.finalCheck.gaps : [],
    lastVerificationFailure: latest([
      ...state.slices.flatMap(sliceVerificationFailure),
      ...finalVerificationFailure(state),
    ]),
  };
}

/** The failure recorded last. */
function latest(
  failures: VerificationFailureDiagnostic[],
): VerificationFailureDiagnostic | undefined {
  return failures.reduce<VerificationFailureDiagnostic | undefined>(
    (found, failure) => (found === undefined || failure.at > found.at ? failure : found),
    undefined,
  );
}

function sliceVerificationFailure(slice: Slice): VerificationFailureDiagnostic[] {
  const failed = slice.failedVerification;
  if (!failed) return [];
  return [
    {
      scope: { kind: 'slice', sliceId: slice.id },
      command: failed.command,
      output: failed.output,
      at: failed.at,
      current: !failed.passedSince && slice.status !== 'approved',
    },
  ];
}

function finalVerificationFailure(state: RunState): VerificationFailureDiagnostic[] {
  const failed = state.failedFinalVerification;
  if (!failed) return [];
  return [
    {
      scope: { kind: 'finalCheck', round: failed.round },
      command: failed.command,
      output: failed.output,
      at: failed.at,
      current: !failed.passedSince,
    },
  ];
}
