import { z } from 'zod';

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

export function captureOutput(output: string | undefined): CapturedOutput {
  if (output === undefined) return OUTPUT_UNAVAILABLE;
  const truncated = output.length > DIAGNOSTIC_OUTPUT_TAIL;
  return {
    captured: true,
    tail: truncated ? output.slice(-DIAGNOSTIC_OUTPUT_TAIL) : output,
    truncated,
  };
}

export const OUTPUT_UNAVAILABLE: CapturedOutput = { captured: false };

/** How much of a failed command's output the run keeps, from its end, where failures report. */
export const DIAGNOSTIC_OUTPUT_TAIL = 3000;

/**
 * Where a recorded failure falls among the run's others: the run's failure count when it was
 * recorded. A failure saved before failures were counted loads as 0, earlier than any counted one.
 */
export const diagnosticOrderSchema = z.number().int().nonnegative().default(0);

/** A review's requested changes, kept until a later review of the same slice approves it. */
export const rejectedReviewSchema = z.object({
  feedback: z.string(),
  at: diagnosticOrderSchema,
});

export type RejectedReview = z.infer<typeof rejectedReviewSchema>;

/**
 * The tail of a failed command's output as a run keeps it, verbatim so the file and line
 * references in it survive, or the admission that a run saved before output was kept has none.
 */
export const capturedOutputSchema = z.discriminatedUnion('captured', [
  z.object({ captured: z.literal(true), tail: z.string(), truncated: z.boolean() }),
  z.object({ captured: z.literal(false) }),
]);

export type CapturedOutput = z.infer<typeof capturedOutputSchema>;

/**
 * The last whole-run verification that failed, kept after a later check passes so the run still
 * shows what its repair addressed.
 */
export const failedFinalVerificationSchema = z.object({
  command: z.string().min(1).optional(),
  output: capturedOutputSchema,
  round: z.number().int().min(1),
  at: diagnosticOrderSchema,
  passedSince: z.boolean(),
});

export type FailedFinalVerification = z.infer<typeof failedFinalVerificationSchema>;

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

/** The failure recorded last; among failures saved before they were ordered, the later listed. */
function latest(
  failures: VerificationFailureDiagnostic[],
): VerificationFailureDiagnostic | undefined {
  return failures.reduce<VerificationFailureDiagnostic | undefined>(
    (found, failure) => (found === undefined || failure.at >= found.at ? failure : found),
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

/**
 * The run's last whole-run verification failure. A run saved before these were kept still
 * records that its latest check failed verification, so that one stands in with no output.
 */
function finalVerificationFailure(state: RunState): VerificationFailureDiagnostic[] {
  const failed = state.failedFinalVerification;
  if (failed) {
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
  const check = state.finalCheck;
  if (!check || check.verified) return [];
  return [
    {
      scope: { kind: 'finalCheck', round: check.round },
      command: check.command,
      output: OUTPUT_UNAVAILABLE,
      at: 0,
      current: true,
    },
  ];
}
