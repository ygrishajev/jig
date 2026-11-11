import { panic, Result } from 'better-result';
import { z } from 'zod';

import { type DesignDocs, designDocsSchema } from './design-docs.js';
import { DesignUnresolved } from './errors.js';
import type { RunState } from './run-state.js';

/** What a re-review checks the revised documents against. */
export interface DesignReReview {
  reviewedDocs: DesignDocs;
  findings: DesignFinding[];
  dispositions: FindingDisposition[];
}

/** The planner's revision of a design under `findings`: one disposition per finding, no more. */
export function designRevisionSchemaFor(
  findings: readonly DesignFinding[],
): z.ZodType<DesignRevision> {
  return designRevisionSchema.superRefine(({ dispositions }, context) => {
    for (const problem of dispositionProblems(findings, dispositions)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['dispositions'], message: problem });
    }
  });
}

/** How the planner answered one finding: changed the design, or disputed it with evidence. */
export const findingDispositionSchema = z.discriminatedUnion('status', [
  z.object({
    findingId: z.string().trim().min(1),
    status: z.literal('addressed'),
    change: z.string().min(1),
  }),
  z.object({
    findingId: z.string().trim().min(1),
    status: z.literal('disputed'),
    reasoning: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
  }),
]);

export type FindingDisposition = z.infer<typeof findingDispositionSchema>;

const designRevisionSchema = designDocsSchema.extend({
  dispositions: z.array(findingDispositionSchema),
});

export type DesignRevision = z.infer<typeof designRevisionSchema>;

function dispositionProblems(
  findings: readonly DesignFinding[],
  dispositions: readonly FindingDisposition[],
): string[] {
  const findingIds = findings.map((finding) => finding.id);
  const answered = dispositions.map((disposition) => disposition.findingId);
  const unanswered = findingIds.filter((id) => !answered.includes(id));
  const unknown = answered.filter((id) => !findingIds.includes(id));
  const repeated = repeatedIds(answered);
  return [
    ...(unanswered.length > 0 ? [`No disposition for findings: ${unanswered.join(', ')}`] : []),
    ...(unknown.length > 0 ? [`Dispositions for unknown findings: ${unknown.join(', ')}`] : []),
    ...(repeated.length > 0 ? [`More than one disposition for: ${repeated.join(', ')}`] : []),
  ];
}

function repeatedIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

/** Who can settle a finding: the planner, with a technical correction, or only the operator. */
export const findingResolutionSchema = z.enum(['correction', 'operatorDecision']);

/**
 * One consequential problem the reviewer found in the design or plan. `uncertainty` states what
 * the reviewer could not confirm, so a guess is never passed off as evidence; empty when nothing.
 */
export const designFindingSchema = z.object({
  id: z.string().trim().min(1),
  concern: z.string().min(1),
  failureScenario: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  recommendation: z.string().min(1),
  resolution: findingResolutionSchema,
  uncertainty: z.string(),
});

export type DesignFinding = z.infer<typeof designFindingSchema>;

/** The reviewer's verdict is its findings alone: an empty list approves, so the two cannot disagree. */
export const designReviewSchema = z
  .object({ findings: z.array(designFindingSchema) })
  .superRefine(({ findings }, context) => {
    const repeated = repeatedIds(findings.map((finding) => finding.id));
    if (repeated.length === 0) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['findings'],
      message: `Finding ids must be unique; repeated: ${repeated.join(', ')}`,
    });
  });

export type DesignReview = z.infer<typeof designReviewSchema>;

/**
 * A design is reviewed at most twice: once as written, and once more after the planner's one
 * revision. The cap is the design review's own, independent of the slice review cap.
 */
export const MAX_DESIGN_REVIEWS = 2;

/** The planner's one revision, kept with the documents it revised so the re-review can compare. */
const designRevisionRecordSchema = z.object({
  reviewedDocs: designDocsSchema,
  dispositions: z.array(findingDispositionSchema),
});

/**
 * How far a run's design review has come. A second review only ever follows the revision, so a
 * saved run can neither skip the revision nor be granted another one.
 */
export const designReviewProgressSchema = z
  .object({
    reviews: z.array(designReviewSchema).min(1).max(MAX_DESIGN_REVIEWS),
    revision: designRevisionRecordSchema.optional(),
  })
  .refine(({ reviews, revision }) => reviews.length === 1 || revision !== undefined, {
    message: 'A second design review must follow the revision it reviewed',
  });

export type DesignReviewProgress = z.infer<typeof designReviewProgressSchema>;

/**
 * What each stage of the design review requires of the saved progress, so a stale or hand-edited
 * run fails when it is loaded rather than panicking in the step it resumes. A run saved past the
 * review may have none — it predates design reviews — but any it has must have approved the design.
 */
export const designReviewProgressAt = {
  reReview: designReviewProgressSchema.refine(
    ({ reviews, revision }) => reviews.length === 1 && revision !== undefined,
    { message: 'A design re-review must follow exactly one review and its revision' },
  ),
  revision: designReviewProgressSchema.refine(designRevisionOwed, {
    message: 'A design revision must follow one review that found problems',
  }),
  resolution: designReviewProgressSchema.refine(
    (progress) =>
      progress.reviews.length === MAX_DESIGN_REVIEWS && outstandingFindings(progress).length > 0,
    { message: 'Resolving a design must follow a re-review that left findings standing' },
  ),
  settled: designReviewProgressSchema.refine(
    (progress) => outstandingFindings(progress).length === 0,
    { message: 'A run past the design review must carry an approved design' },
  ),
};

function designRevisionOwed(progress: DesignReviewProgress): boolean {
  return (
    progress.reviews.length === 1 &&
    progress.revision === undefined &&
    outstandingFindings(progress).length > 0
  );
}

function outstandingFindings(progress: DesignReviewProgress): DesignFinding[] {
  return progress.reviews.at(-1)?.findings ?? [];
}

/** Folds a completed review into the run; a review past the cap or out of turn is a bug. */
export function recordDesignReview(state: RunState, review: DesignReview): RunState {
  const reviews = [...(state.designReview?.reviews ?? []), review];
  if (reviews.length > MAX_DESIGN_REVIEWS) {
    panic(`Run ${state.runId} has already had its ${MAX_DESIGN_REVIEWS} design reviews`);
  }
  if (reviews.length > 1 && state.designReview?.revision === undefined) {
    panic(`Run ${state.runId} cannot re-review a design that was never revised`);
  }
  return { ...state, designReview: { ...state.designReview, reviews } };
}

/**
 * Folds the planner's one revision into the run atomically: the revised documents replace the
 * reviewed ones, which are kept beside the dispositions for the re-review.
 */
export function recordDesignRevision(state: RunState, revision: DesignRevision): RunState {
  const progress = state.designReview;
  if (!state.docs || !progress || !designRevisionOwed(progress)) {
    panic(`Run ${state.runId} owes no design revision`);
  }
  const { design, plan, dispositions } = revision;
  return {
    ...state,
    docs: { design, plan },
    designReview: { ...progress, revision: { reviewedDocs: state.docs, dispositions } },
  };
}

/** The latest review of the run's design found nothing, so its plan may be sliced. */
export function designApproved(state: RunState): boolean {
  const progress = state.designReview;
  return progress !== undefined && outstandingFindings(progress).length === 0;
}

/** The first review found problems and the planner has not yet had its one revision. */
export function designNeedsRevision(state: RunState): boolean {
  return state.designReview !== undefined && designRevisionOwed(state.designReview);
}

/** The re-review's inputs once the planner has revised the design; undefined before that. */
export function designReReview(state: RunState): DesignReReview | undefined {
  const progress = state.designReview;
  if (progress?.revision === undefined) return undefined;
  return { ...progress.revision, findings: findingsToRevise(progress) };
}

/** The findings the planner's revision must answer. */
export function findingsToRevise(progress: DesignReviewProgress): DesignFinding[] {
  return progress.reviews[0].findings;
}

/**
 * Lets an approved design on to slicing; a design still carrying findings after its one revision
 * stops the run for the operator, in either gate mode, naming what is unresolved.
 */
export function resolveDesignReview(
  progress: DesignReviewProgress,
): Result<void, DesignUnresolved> {
  const outstanding = outstandingFindings(progress);
  if (outstanding.length === 0) return Result.ok();
  return Result.err(
    new DesignUnresolved({
      message: [
        `The design review left ${outstanding.length} finding${outstanding.length > 1 ? 's' : ''} unresolved after the planner's one revision:`,
        ...outstanding.map(unresolvedFindingLine),
      ].join('\n'),
      findingIds: outstanding.map((finding) => finding.id),
    }),
  );
}

function unresolvedFindingLine(finding: DesignFinding): string {
  const needs = finding.resolution === 'operatorDecision' ? ' (needs an operator decision)' : '';
  return `- ${finding.id}${needs}: ${finding.concern} — recommended: ${finding.recommendation}`;
}
