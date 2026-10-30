import { z } from 'zod';
import { runIdSchema, type RunId } from './run-id.js';
import { sliceSchema, slicesInOrder, type Slice } from './slice.js';

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

/** What every run carries, whatever its phase; what a phase adds is required from that phase on. */
const runFields = z.object({
  runId: runIdSchema,
  /**
   * How many times the run has been saved. When several stores hold a copy, the highest revision
   * is the freshest: a counter rather than a timestamp, because the machines saving it do not
   * share a clock. A run saved before revisions were counted loads as revision 0.
   */
  revision: z.number().int().nonnegative().default(0),
  baseBranch: z.string().min(1),
  request: z.string(),
  context: runContextSchema.optional(),
  plan: featurePlanSchema.optional(),
  docs: designDocsSchema.optional(),
  slices: z.array(sliceSchema),
  prDescription: z.string().optional(),
  /** Why the last invocation stopped short; cleared when the run is resumed. */
  blockedReason: z.string().optional(),
});
const withContext = runFields.extend({ context: runContextSchema });
const withPlan = withContext.extend({ plan: featurePlanSchema });
const withDocs = withPlan.extend({ docs: designDocsSchema });
const withDescription = withDocs.extend({ prDescription: z.string() });

/**
 * A run as it is saved and loaded. Each phase guarantees what the phases before it produced, so
 * a hand-edited or stale file that lacks it fails here, at the boundary, not in a later step.
 */
export const runStateSchema = z.discriminatedUnion('phase', [
  runFields.extend({ phase: runPhaseSchema.extract(['context']) }),
  withContext.extend({ phase: runPhaseSchema.extract(['planning']) }),
  withPlan.extend({ phase: runPhaseSchema.extract(['designing']) }),
  withDocs.extend({
    phase: runPhaseSchema.extract(['slicing', 'gate', 'paused', 'slices', 'describing']),
  }),
  withDescription.extend({
    phase: runPhaseSchema.extract(['merging', 'awaitingMerge', 'done', 'stuck']),
  }),
]);
export type RunState = z.infer<typeof runStateSchema>;

/** A run in phase `P`, with everything that phase guarantees. */
export type RunStateIn<P extends RunPhase> = RunState & { phase: P };

export function startRun(input: { runId: RunId; baseBranch: string; request: string }): RunState {
  return { ...input, revision: 0, phase: 'context', slices: [] };
}

/** A run was moved into a phase without what that phase guarantees: the flow is out of order. */
export class PhaseOutOfOrder extends Error {}

/** Moves a run into `phase`, checking it carries everything `phase` guarantees. */
export function enterPhase(state: RunState, phase: RunPhase): RunState {
  const entered = runStateSchema.safeParse({ ...state, phase });
  if (!entered.success) {
    throw new PhaseOutOfOrder(
      `Run ${state.runId} cannot enter "${phase}": ${entered.error.message}`,
    );
  }
  return entered.data;
}

/** Every slice commits onto this one branch, so the whole feature lands as one merge. */
export function runBranchFor(runId: RunId) {
  return `sdlc/run/${runId}`;
}

/** The first slice, by order, that has not been approved — a stuck slice stays current. */
export function currentSlice(state: RunState): Slice | undefined {
  return slicesInOrder(state.slices).find((slice) => slice.status !== 'approved');
}
