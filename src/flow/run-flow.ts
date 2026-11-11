import { designApproved, designNeedsRevision } from '../domain/design-review.js';
import { finalCheckFailed, finalCheckNeedsRepair } from '../domain/final-check.js';
import { stuckSlice } from '../domain/run-state.js';
import {
  emptyAttemptCapReached,
  reviewCapReached,
  ruleFixCapReached,
  sliceNeedsVerification,
} from '../domain/settings.js';
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
import { defineRunFlow, defineSliceFlow, type Guard } from './define-flow.js';

const designPassedReview: Guard = ({ state }) => designApproved(state);

const designOwesRevision: Guard = ({ state }) => designNeedsRevision(state);

const sliceReachedReviewCap: Guard = ({ slice, settings }) =>
  slice !== undefined && reviewCapReached(slice, settings);

const backToImplementUnlessCapped = [
  { to: 'stuck', when: sliceReachedReviewCap },
  { to: 'pending' },
] as const;

const sliceReachedEmptyAttemptCap: Guard = ({ slice }) =>
  slice !== undefined && emptyAttemptCapReached(slice);

const retryUnlessEmptyAttemptsCapped = [
  { to: 'stuck', when: sliceReachedEmptyAttemptCap },
  { to: 'pending' },
] as const;

const sliceAwaitsVerification: Guard = ({ slice, settings }) =>
  slice !== undefined && sliceNeedsVerification(slice, settings);

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
      changesRequested: backToImplementUnlessCapped,
      nothingChanged: retryUnlessEmptyAttemptsCapped,
    },
  },
  verifying: {
    step: verifySlice,
    on: { verified: 'in_review', changesRequested: backToImplementUnlessCapped },
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

/**
 * A whole run: plan the work, have the design reviewed — with one revision and one re-review
 * when the review finds problems, blocking on any left standing — then deliver it slice by
 * slice, check the whole request is fulfilled, describe it, merge it. A stuck slice bypasses the final check; a failed one sends its one
 * repair back through the slices before the run is described and, still failing, stops for a
 * person — so the feedback reaches whoever picks it up.
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
  slices: { forEachSlice: sliceFlow, on: { allApproved: 'finalCheck', sliceStuck: 'describing' } },
  finalCheck: {
    step: checkWholeRun,
    on: { finalChecked: [{ to: 'slices', when: repairStillOwed }, { to: 'describing' }] },
  },
  describing: {
    step: describePullRequest,
    on: {
      described: [
        { to: 'stuck', when: someSliceStuck },
        { to: 'stuck', when: theFinalCheckFailed },
        { to: 'merging' },
      ],
    },
  },
  merging: { step: mergeRunBranch, on: { merged: 'done', awaitingManualMerge: 'awaitingMerge' } },
  awaitingMerge: { halt: true, resumeAt: 'merging' },
  done: { final: 'done' },
  stuck: { final: 'stuck' },
});
