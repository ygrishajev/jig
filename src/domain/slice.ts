import { z } from 'zod';

import {
  capturedOutputSchema,
  diagnosticOrderSchema,
  OUTPUT_UNAVAILABLE,
  rejectedReviewSchema,
} from './diagnostics.js';
import { workObservationsSchema } from './work-facts.js';

/** Slice ids become lookup keys in state and log lines, so they are restricted to safe characters. */
export const SLICE_ID_PATTERN = /^[a-z0-9-]+$/;

export const SLICE_ID_MESSAGE = 'slice id must be lowercase letters, digits and hyphens';

export const plannedSliceSchema = z.object({
  id: z.string().regex(SLICE_ID_PATTERN, SLICE_ID_MESSAGE),
  title: z.string().min(1),
  description: z.string().min(1),
});

export type PlannedSlice = z.infer<typeof plannedSliceSchema>;

export const sliceStatusSchema = z.enum(['pending', 'in_review', 'verifying', 'approved', 'stuck']);

export type SliceStatus = z.infer<typeof sliceStatusSchema>;

/** What a slice's verification recorded: the command that passed, and where the work stood around it. */
export const verificationRecordSchema = z.object({
  command: z.string().min(1),
  observed: workObservationsSchema.optional(),
});

/**
 * What a slice's last failed verification ran, reported and left behind: a failing command can
 * change the work it failed on, so the facts around it are recorded for the audit. It stays after
 * a later verification passes, marked `passedSince`; one saved before output was kept has none.
 */
export const failedVerificationSchema = z.object({
  command: z.string().min(1),
  observed: workObservationsSchema,
  output: capturedOutputSchema.default(OUTPUT_UNAVAILABLE),
  at: diagnosticOrderSchema,
  passedSince: z.boolean().default(false),
});

export type FailedVerification = z.infer<typeof failedVerificationSchema>;

export const sliceSchema = plannedSliceSchema.extend({
  order: z.number().int().nonnegative(),
  status: sliceStatusSchema,
  reviewCycles: z.number().int().nonnegative(),
  hookFailures: z.number().int().nonnegative().default(0),
  verificationFailures: z.number().int().nonnegative().default(0),
  emptyAttempts: z.number().int().nonnegative().default(0),
  ruleFixCycles: z.number().int().nonnegative().default(0),
  lastFeedback: z.string().optional(),
  feedbackHistory: z.array(z.string()).default([]),
  commit: z.string().optional(),
  verification: verificationRecordSchema.optional(),
  failedVerification: failedVerificationSchema.optional(),
  rejectedReview: rejectedReviewSchema.optional(),
});

export type Slice = z.infer<typeof sliceSchema>;

export function sliceFromPlan(planned: PlannedSlice, order: number): Slice {
  return {
    ...planned,
    order,
    status: 'pending',
    reviewCycles: 0,
    hookFailures: 0,
    verificationFailures: 0,
    emptyAttempts: 0,
    ruleFixCycles: 0,
    feedbackHistory: [],
  };
}

/**
 * The rounds before the one the implementer still has to address: once `lastFeedback` is cleared
 * the whole history is earlier, because every round in it was already worked on.
 */
export function earlierFeedback(slice: Slice): string[] {
  if (!slice.lastFeedback) return slice.feedbackHistory;
  return slice.feedbackHistory.slice(0, -1);
}

export function slicesInOrder(slices: readonly Slice[]): Slice[] {
  return [...slices].sort((a, b) => a.order - b.order);
}
