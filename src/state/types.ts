import { z } from 'zod';

// A slice id is used as a stable lookup key across state files and log
// lines, so it's constrained to characters that are always safe there rather
// than accepting arbitrary agent-provided text.
export const sliceIdPattern = /^[a-z0-9-]+$/;

export const sliceStatusSchema = z.enum([
  'pending',
  'implementing',
  'in_review',
  'ready_to_merge',
  'merged',
  'stuck',
]);
export type SliceStatus = z.infer<typeof sliceStatusSchema>;

export const sliceSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(sliceIdPattern, 'slice id must be lowercase alphanumeric characters and hyphens only'),
  title: z.string().min(1),
  description: z.string().min(1),
  order: z.number().int().nonnegative(),
  status: sliceStatusSchema,
  reviewCycles: z.number().int().nonnegative(),
  mergeAttempts: z.number().int().nonnegative(),
  lastFeedback: z.string().optional(),
});
export type Slice = z.infer<typeof sliceSchema>;

export const slicesSchema = z.array(sliceSchema);

export const runContextSchema = z.object({
  rawRequest: z.string(),
  classification: z.string(),
  repoSummary: z.string(),
  createdAt: z.string(),
});
export type RunContext = z.infer<typeof runContextSchema>;

export const runPlanSchema = z.object({
  summary: z.string(),
  approach: z.string(),
  affectedAreas: z.array(z.string()),
});
export type RunPlan = z.infer<typeof runPlanSchema>;

export const runMetaSchema = z.object({
  runId: z.string().min(1),
  baseBranch: z.string().min(1),
  currentSliceId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunMeta = z.infer<typeof runMetaSchema>;

/**
 * Every slice in a run commits onto this single branch — one branch per run,
 * not one per slice — so the whole feature lands as one merge/PR.
 */
export function runBranchFor(runId: string): string {
  return `sdlc/run/${runId}`;
}
