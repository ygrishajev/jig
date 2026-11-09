import { z } from 'zod';

/** Slice ids become lookup keys in state and log lines, so they are restricted to safe characters. */
export const SLICE_ID_PATTERN = /^[a-z0-9-]+$/;

export const plannedSliceSchema = z.object({
  id: z.string().regex(SLICE_ID_PATTERN, 'slice id must be lowercase letters, digits and hyphens'),
  title: z.string().min(1),
  description: z.string().min(1),
});

export type PlannedSlice = z.infer<typeof plannedSliceSchema>;

export const sliceStatusSchema = z.enum(['pending', 'in_review', 'verifying', 'approved', 'stuck']);

export type SliceStatus = z.infer<typeof sliceStatusSchema>;

export const sliceSchema = plannedSliceSchema.extend({
  order: z.number().int().nonnegative(),
  status: sliceStatusSchema,
  reviewCycles: z.number().int().nonnegative(),
  emptyAttempts: z.number().int().nonnegative().default(0),
  ruleFixCycles: z.number().int().nonnegative().default(0),
  lastFeedback: z.string().optional(),
  commit: z.string().optional(),
  verification: z.object({ command: z.string() }).optional(),
});

export type Slice = z.infer<typeof sliceSchema>;

export function sliceFromPlan(planned: PlannedSlice, order: number): Slice {
  return {
    ...planned,
    order,
    status: 'pending',
    reviewCycles: 0,
    emptyAttempts: 0,
    ruleFixCycles: 0,
  };
}

export function slicesInOrder(slices: readonly Slice[]): Slice[] {
  return [...slices].sort((a, b) => a.order - b.order);
}
