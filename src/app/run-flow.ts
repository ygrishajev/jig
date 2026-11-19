import { designApproved, designNeedsRevision } from '../domain/design-review.js';
import { finalCheckFailed, finalCheckNeedsRepair } from '../domain/final-check.js';
import { runMerges, stuckSlice } from '../domain/run-state.js';
import {
  emptyAttemptCapReached,
  hookFailureCapReached,
  reviewCapReached,
  ruleFixCapReached,
  sliceNeedsVerification,
  verificationFailureCapReached,
} from '../domain/settings.js';
import { defineRunFlow, defineSliceFlow, type Guard } from '../flow/define-flow.js';
import { decideCompletionReuse } from '../steps/completion-reuse.js';
import { resolveDesign, reviewDesign, reviseDesign } from '../steps/design-review.js';
import { checkWholeRun } from '../steps/final-check.js';
import { describePullRequest, mergeRunBranch } from '../steps/finishing.js';
import {
  applyDesignGate,
  buildContext,
  planFeature,
  sliceThePlan,
  writeDesign,
} from '../steps/planning.js';
import { implementSlice, reviewSlice, verifySlice } from '../steps/slice.js';

const designPassedReview: Guard = ({ state }) => designApproved(state);

const designOwesRevision: Guard = ({ state }) => designNeedsRevision(state);

const sliceReachedHookFailureCap: Guard = ({ slice }) =>
  slice !== undefined && hookFailureCapReached(slice);

const sliceReachedEmptyAttemptCap: Guard = ({ slice }) =>
  slice !== undefined && emptyAttemptCapReached(slice);

const retryUnlessEmptyAttemptsCapped = [
  { to: 'stuck', when: sliceReachedEmptyAttemptCap },
  { to: 'pending' },
] as const;

const sliceReachedVerificationFailureCap: Guard = ({ slice }) =>
  slice !== undefined && verificationFailureCapReached(slice);

const sliceAwaitsVerification: Guard = ({ slice, settings }) =>
  slice !== undefined && sliceNeedsVerification(slice, settings);

const sliceReachedReviewCap: Guard = ({ slice, settings }) =>
  slice !== undefined && reviewCapReached(slice, settings);

const backToImplementUnlessCapped = [
  { to: 'stuck', when: sliceReachedReviewCap },
  { to: 'pending' },
] as const;

const sliceReachedRuleFixCap: Guard = ({ slice }) =>
  slice !== undefined && ruleFixCapReached(slice);

const backToImplementUnlessRuleFixesCapped = [
  { to: 'stuck', when: sliceReachedRuleFixCap },
  { to: 'pending' },
] as const;

/** One slice: implement it, verify it, have it reviewed — and loop back on any requested change. */
export const sliceFlow = defineSliceFlow({
  pending: {
    step: implementSlice,
    on: {
      implemented: 'verifying',
      hookRejected: [{ to: 'stuck', when: sliceReachedHookFailureCap }, { to: 'pending' }],
      nothingChanged: retryUnlessEmptyAttemptsCapped,
    },
  },
  verifying: {
    step: verifySlice,
    on: {
      verified: 'in_review',
      verificationFailed: [
        { to: 'stuck', when: sliceReachedVerificationFailureCap },
        { to: 'pending' },
      ],
    },
  },
  in_review: {
    step: reviewSlice,
    on: {
      approved: [{ to: 'verifying', when: sliceAwaitsVerification }, { to: 'approved' }],
      changesRequested: backToImplementUnlessCapped,
      rulesFixRequested: backToImplementUnlessRuleFixesCapped,
    },
  },
  approved: { final: 'done' },
  stuck: { final: 'stuck' },
});

const repairStillOwed: Guard = ({ state }) => finalCheckNeedsRepair(state);

const someSliceStuck: Guard = ({ state }) => stuckSlice(state) !== undefined;

const theFinalCheckFailed: Guard = ({ state }) => finalCheckFailed(state);

const runSkipsMerge: Guard = ({ state }) => !runMerges(state);

/**
 * A whole run: plan the work, have the design reviewed — with one revision and one re-review
 * when the review finds problems, blocking on any left standing — then deliver it slice by
 * slice, check the whole request is fulfilled, describe it, merge it — or, for a run that skips
 * the merge, finish as `completed` with its branch left for review. A stuck slice bypasses the final check; a failed one sends its one
 * repair back through the slices before the run is described and, still failing, stops for a
 * person — so the feedback reaches whoever picks it up. A single-slice run whose combined review
 * still vouches for its work finishes on that review instead of a final check; should the
 * evidence stop holding before the run merges or waits for a merge, the run falls back to an
 * ordinary final check with its repair still owed.
 */
export const runFlow = defineRunFlow({
  context: { step: buildContext, on: { contextBuilt: 'planning' } },
  planning: { step: planFeature, on: { featurePlanned: 'designing' } },
  designing: { step: writeDesign, on: { designWritten: 'reviewingDesign' } },
  reviewingDesign: {
    step: reviewDesign,
    on: {
      designReviewed: [
        { to: 'slicing', when: designPassedReview },
        { to: 'revisingDesign', when: designOwesRevision },
        { to: 'resolvingDesign' },
      ],
    },
  },
  revisingDesign: { step: reviseDesign, on: { designRevised: 'reviewingDesign' } },
  resolvingDesign: { step: resolveDesign, on: { continue: 'slicing' } },
  slicing: { step: sliceThePlan, on: { sliced: 'gate' } },
  gate: { step: applyDesignGate, on: { continue: 'slices', pause: 'paused' } },
  paused: { halt: true, resumeAt: 'slices' },
  slices: {
    forEachSlice: sliceFlow,
    on: { allApproved: 'checkingReuse', sliceStuck: 'describing' },
  },
  checkingReuse: {
    step: decideCompletionReuse,
    on: { completionReused: 'describing', completionDeclined: 'finalCheck' },
  },
  finalCheck: {
    step: checkWholeRun,
    on: { finalChecked: [{ to: 'slices', when: repairStillOwed }, { to: 'describing' }] },
  },
  describing: {
    step: describePullRequest,
    on: {
      completionInvalidated: 'finalCheck',
      described: [
        { to: 'stuck', when: someSliceStuck },
        { to: 'stuck', when: theFinalCheckFailed },
        { to: 'completed', when: runSkipsMerge },
        { to: 'merging' },
      ],
    },
  },
  merging: {
    step: mergeRunBranch,
    on: {
      merged: 'done',
      awaitingManualMerge: 'awaitingMerge',
      completionInvalidated: 'finalCheck',
    },
  },
  awaitingMerge: { halt: true, resumeAt: 'merging' },
  completed: { final: 'completed' },
  done: { final: 'done' },
  stuck: { final: 'stuck' },
});
