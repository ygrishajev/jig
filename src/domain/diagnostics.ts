import { z } from 'zod';

interface RetainedFinalVerificationInput {
  failedFinalVerification?: FailedFinalVerification;
  finalCheck?: { verified: boolean; command?: string; round: number };
}

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

/**
 * The run's last whole-run verification failure. A run saved before these were kept still
 * records that its latest check failed verification, so that one stands in, unordered and with
 * no output, until a later check replaces it.
 */
export function retainedFinalVerificationFailure(
  state: RetainedFinalVerificationInput,
): FailedFinalVerification | undefined {
  if (state.failedFinalVerification) return state.failedFinalVerification;
  const check = state.finalCheck;
  if (!check || check.verified) return undefined;
  return {
    command: check.command,
    output: OUTPUT_UNAVAILABLE,
    round: check.round,
    at: 0,
    passedSince: false,
  };
}
