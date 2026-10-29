import { z } from 'zod';
import { RUN_ID_PATTERN, type RunState } from '../../domain/run-state.js';
import { SLICE_ID_PATTERN } from '../../domain/slice.js';

const sliceSchema = z.object({
  id: z.string().regex(SLICE_ID_PATTERN),
  title: z.string(),
  description: z.string(),
  order: z.number().int().nonnegative(),
  status: z.enum(['pending', 'in_review', 'verifying', 'approved', 'stuck']),
  reviewCycles: z.number().int().nonnegative(),
  lastFeedback: z.string().optional(),
  commit: z.string().optional(),
});

/** Validates a saved run on the way back in, so a hand-edited or stale file fails loudly. */
export const runStateSchema: z.ZodType<RunState> = z.object({
  runId: z.string().regex(RUN_ID_PATTERN),
  baseBranch: z.string().min(1),
  request: z.string(),
  phase: z.enum([
    'context',
    'planning',
    'designing',
    'slicing',
    'gate',
    'paused',
    'slices',
    'describing',
    'merging',
    'awaitingMerge',
    'done',
    'stuck',
  ]),
  context: z.object({ classification: z.string(), repoSummary: z.string() }).optional(),
  plan: z
    .object({ summary: z.string(), approach: z.string(), affectedAreas: z.array(z.string()) })
    .optional(),
  docs: z.object({ design: z.string(), plan: z.string() }).optional(),
  slices: z.array(sliceSchema),
  prDescription: z.string().optional(),
  blockedReason: z.string().optional(),
});
