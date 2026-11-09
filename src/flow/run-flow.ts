import { stuckSlice } from '../domain/run-state.js';
import {
  emptyAttemptCapReached,
  reviewCapReached,
  sliceNeedsVerification,
} from '../domain/settings.js';
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
    },
  },
  approved: { final: 'done' },
  stuck: { final: 'stuck' },
});

const someSliceStuck: Guard = ({ state }) => stuckSlice(state) !== undefined;

/**
 * A whole run: plan the work, deliver it slice by slice, describe it, merge it. A run with a
 * stuck slice is still described, so the reviewer's feedback reaches whoever picks it up.
 */
export const runFlow = defineRunFlow({
  context: { step: buildContext, on: { contextBuilt: 'planning' } },
  planning: { step: planFeature, on: { featurePlanned: 'designing' } },
  designing: { step: writeDesign, on: { designWritten: 'slicing' } },
  slicing: { step: sliceThePlan, on: { sliced: 'gate' } },
  gate: { step: applyDesignGate, on: { continue: 'slices', pause: 'paused' } },
  paused: { halt: true, resumeAt: 'slices' },
  slices: { forEachSlice: sliceFlow, on: { allApproved: 'describing', sliceStuck: 'describing' } },
  describing: {
    step: describePullRequest,
    on: { described: [{ to: 'stuck', when: someSliceStuck }, { to: 'merging' }] },
  },
  merging: { step: mergeRunBranch, on: { merged: 'done', awaitingManualMerge: 'awaitingMerge' } },
  awaitingMerge: { halt: true, resumeAt: 'merging' },
  done: { final: 'done' },
  stuck: { final: 'stuck' },
});
