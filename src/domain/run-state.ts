import { panic } from 'better-result';
import { z } from 'zod';

import { completionEvidenceSchema } from './completion-reuse.js';
import { designDocsSchema } from './design-docs.js';
import { designReviewProgressAt, designReviewProgressSchema } from './design-review.js';
import { failedFinalVerificationSchema } from './diagnostics.js';
import { finalCheckFailed } from './final-check.js';
import { type RunId, runIdSchema } from './run-id.js';
import { sliceStopReason } from './settings.js';
import { type Slice, sliceSchema, slicesInOrder } from './slice.js';

/** Which run a sandbox or scope belongs to, and the branch its work started from. */
export interface RunIdentity {
  runId: RunId;
  baseBranch: string;
}

/** A run in phase `P`, with everything that phase guarantees. */
export type RunStateIn<P extends RunPhase> = RunState & { phase: P };

export function startRun(input: {
  runId: RunId;
  baseBranch: string;
  request: string;
  merge?: boolean;
  codePublication?: CodePublication;
  startingCommit?: string;
}): RunState {
  return {
    ...input,
    merge: input.merge ?? true,
    revision: 0,
    diagnosticSequence: 0,
    phase: 'context',
    slices: [],
  };
}

/** Moves a run into `phase`, checking it carries everything `phase` guarantees. */
export function enterPhase(state: Omit<RunState, 'phase'>, phase: RunPhase): RunState {
  const entered = runStateSchema.safeParse({ ...state, phase });
  if (!entered.success) {
    panic(`Run ${state.runId} cannot enter "${phase}": ${entered.error.message}`);
  }
  return entered.data;
}

export const codePublicationSchema = z.enum(['deferred']);

export type CodePublication = z.infer<typeof codePublicationSchema>;

export const runContextSchema = z.object({ classification: z.string(), repoSummary: z.string() });

export type RunContext = z.infer<typeof runContextSchema>;

export const featurePlanSchema = z.object({
  summary: z.string(),
  approach: z.string(),
  affectedAreas: z.array(z.string()),
});

export type FeaturePlan = z.infer<typeof featurePlanSchema>;

/** What the run's whole-request final check decided, recorded as each check completes. */
export const finalCheckResultSchema = z.object({
  verified: z.boolean(),
  command: z.string().optional(),
  fulfilled: z.boolean(),
  gaps: z.array(z.string()),
  round: z.number().int().min(1),
});

export type FinalCheckResult = z.infer<typeof finalCheckResultSchema>;

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
  /** Whether the run merges its branch when it finishes; a run saved before the choice existed merges. */
  merge: z.boolean().default(true),
  /**
   * `deferred` keeps the run's code off the remote: saves publish state only, recording the
   * commit the run branch held as `codeRevision`, and the code is published by whoever owns it.
   */
  codePublication: codePublicationSchema.optional(),
  /** The commit the run started from; absent on runs saved before it was recorded. */
  startingCommit: z.string().min(1).optional(),
  /** The run branch's commit at the last deferred save: the checkpoint a resume restores. */
  codeRevision: z.string().min(1).optional(),
  context: runContextSchema.optional(),
  plan: featurePlanSchema.optional(),
  docs: designDocsSchema.optional(),
  designReview: designReviewProgressSchema.optional(),
  slices: z.array(sliceSchema),
  finalCheck: finalCheckResultSchema.optional(),
  failedFinalVerification: failedFinalVerificationSchema.optional(),
  /** Counts the send-backs and final checks the run recorded; each failure takes its count as `at`. */
  diagnosticSequence: z.number().int().nonnegative().default(0),
  /**
   * What an eligible slice review recorded about the whole request, bound to the work it saw.
   * Evidence saved before it carried its review scope loads as none, so the run declines reuse.
   */
  completionReuse: completionEvidenceSchema.optional().catch(undefined),
  /**
   * Set once the run was found fit to finish on `completionReuse` instead of a final check;
   * cleared when finishing finds that evidence no longer holds.
   */
  completionReuseAuthorized: z.literal(true).optional(),
  prDescription: z.string().optional(),
  /** Why the last invocation stopped short; cleared when the run is resumed. */
  blockedReason: z.string().optional(),
});

export const runPhaseSchema = z.enum([
  'context',
  'planning',
  'designing',
  'reviewingDesign',
  'revisingDesign',
  'resolvingDesign',
  'slicing',
  'gate',
  'paused',
  'slices',
  'checkingReuse',
  'finalCheck',
  'describing',
  'merging',
  'awaitingMerge',
  'completed',
  'done',
  'stuck',
]);

export type RunPhase = z.infer<typeof runPhaseSchema>;

const withContext = runFields.extend({ context: runContextSchema });

const withPlan = withContext.extend({ plan: featurePlanSchema });

const withDocs = withPlan.extend({ docs: designDocsSchema });

const withSettledDesign = withDocs.extend({
  designReview: designReviewProgressAt.settled.optional(),
});

const withDescription = withSettledDesign.extend({ prDescription: z.string() });

/**
 * A run as it is saved and loaded. Each phase guarantees what the phases before it produced, so
 * a hand-edited or stale file that lacks it fails here, at the boundary, not in a later step.
 */
export const runStateSchema = z.discriminatedUnion('phase', [
  runFields.extend({ phase: runPhaseSchema.extract(['context']) }),
  withContext.extend({ phase: runPhaseSchema.extract(['planning']) }),
  withPlan.extend({ phase: runPhaseSchema.extract(['designing']) }),
  withDocs.extend({
    phase: runPhaseSchema.extract(['reviewingDesign']),
    designReview: designReviewProgressAt.reReview.optional(),
  }),
  withDocs.extend({
    phase: runPhaseSchema.extract(['revisingDesign']),
    designReview: designReviewProgressAt.revision,
  }),
  withDocs.extend({
    phase: runPhaseSchema.extract(['resolvingDesign']),
    designReview: designReviewProgressAt.resolution,
  }),
  withSettledDesign.extend({
    phase: runPhaseSchema.extract([
      'slicing',
      'gate',
      'paused',
      'slices',
      'checkingReuse',
      'finalCheck',
      'describing',
    ]),
  }),
  withDescription.extend({
    phase: runPhaseSchema.extract(['merging', 'awaitingMerge', 'completed', 'done', 'stuck']),
  }),
]);

export type RunState = z.infer<typeof runStateSchema>;

/** Every slice commits onto this one branch, so the whole feature lands as one merge. */
export function runBranchFor(runId: RunId): string {
  return `jig/run/${runId}`;
}

/** The first slice, by order, that has not been approved — a stuck slice stays current. */
export function currentSlice(state: RunState): Slice | undefined {
  return slicesInOrder(state.slices).find((slice) => slice.status !== 'approved');
}

/** Whether the run merges its branch once it is described. */
export function runMerges(state: RunState): boolean {
  return state.merge;
}

/** Whether saves keep the run's code off the remote, leaving its publication to the caller. */
export function defersCodePublication(state: RunState): boolean {
  return state.codePublication === 'deferred';
}

export function runStopReason(state: RunState): string | undefined {
  const slice = stuckSlice(state);
  if (slice) return `slice "${slice.id}": ${sliceStopReason(slice)}`;
  if (state.phase === 'stuck' && finalCheckFailed(state)) {
    return 'the whole-run final check failed after repair';
  }
  return undefined;
}

/** The slice that exhausted an attempt budget; once there is one, the run ends and a person takes over. */
export function stuckSlice(state: RunState): Slice | undefined {
  return state.slices.find((slice) => slice.status === 'stuck');
}
