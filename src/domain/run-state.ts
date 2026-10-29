import { z } from 'zod';
import { runIdSchema, type RunId } from './run-id.js';
import { sliceSchema, type Slice } from './slice.js';

export const runPhaseSchema = z.enum([
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
]);
export type RunPhase = z.infer<typeof runPhaseSchema>;

export const runContextSchema = z.object({ classification: z.string(), repoSummary: z.string() });
export type RunContext = z.infer<typeof runContextSchema>;

export const featurePlanSchema = z.object({
  summary: z.string(),
  approach: z.string(),
  affectedAreas: z.array(z.string()),
});
export type FeaturePlan = z.infer<typeof featurePlanSchema>;

export const designDocsSchema = z.object({ design: z.string().min(1), plan: z.string().min(1) });
export type DesignDocs = z.infer<typeof designDocsSchema>;

/**
 * A run as it is saved and loaded, so a hand-edited or stale file fails loudly at the boundary.
 * A run saved before revisions were counted loads as revision 0.
 */
export const runStateSchema = z.object({
  runId: runIdSchema,
  /**
   * How many times the run has been saved. When several stores hold a copy, the highest revision
   * is the freshest: a counter rather than a timestamp, because the machines saving it do not
   * share a clock.
   */
  revision: z.number().int().nonnegative().default(0),
  baseBranch: z.string().min(1),
  request: z.string(),
  phase: runPhaseSchema,
  context: runContextSchema.optional(),
  plan: featurePlanSchema.optional(),
  docs: designDocsSchema.optional(),
  slices: z.array(sliceSchema),
  prDescription: z.string().optional(),
  blockedReason: z.string().optional(),
});
export type RunState = z.infer<typeof runStateSchema>;

export function startRun(input: { runId: RunId; baseBranch: string; request: string }): RunState {
  return { ...input, revision: 0, phase: 'context', slices: [] };
}

/** Every slice commits onto this one branch, so the whole feature lands as one merge. */
export function runBranchFor(runId: RunId) {
  return `sdlc/run/${runId}`;
}

/** Reads a field an earlier phase must have produced; a missing one means the flow is out of order. */
export function produced<K extends keyof RunState>(
  state: RunState,
  key: K,
): NonNullable<RunState[K]> {
  const value = state[key];
  if (value === undefined || value === null) {
    throw new Error(`Run ${state.runId} reached "${state.phase}" without its ${String(key)}`);
  }
  return value as NonNullable<RunState[K]>;
}

/** The first slice, by order, that has not been approved — a stuck slice stays current. */
export function currentSlice(state: RunState): Slice | undefined {
  return [...state.slices]
    .sort((a, b) => a.order - b.order)
    .find((slice) => slice.status !== 'approved');
}
