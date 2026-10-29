import { reviewCapReached } from '../domain/settings.js';
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

/** One slice: implement it, have it reviewed, verify it — and loop back on any requested change. */
export const sliceFlow = defineSliceFlow({
  pending: { step: implementSlice, on: { implemented: 'in_review' } },
  in_review: {
    step: reviewSlice,
    on: { approved: 'verifying', changesRequested: backToImplementUnlessCapped },
  },
  verifying: {
    step: verifySlice,
    on: { verified: 'approved', changesRequested: backToImplementUnlessCapped },
  },
  approved: { final: 'done' },
  stuck: { final: 'stuck' },
});

/** A whole run: plan the work, deliver it slice by slice, describe it, merge it. */
export const runFlow = defineRunFlow({
  context: { step: buildContext, on: { contextBuilt: 'planning' } },
  planning: { step: planFeature, on: { featurePlanned: 'designing' } },
  designing: { step: writeDesign, on: { designWritten: 'slicing' } },
  slicing: { step: sliceThePlan, on: { sliced: 'gate' } },
  gate: { step: applyDesignGate, on: { continue: 'slices', pause: 'paused' } },
  paused: { halt: true, resumeAt: 'slices' },
  slices: { forEachSlice: sliceFlow, on: { allApproved: 'describing', sliceStuck: 'stuck' } },
  describing: { step: describePullRequest, on: { described: 'merging' } },
  merging: { step: mergeRunBranch, on: { merged: 'done', awaitingManualMerge: 'awaitingMerge' } },
  awaitingMerge: { halt: true, resumeAt: 'merging' },
  done: { final: 'done' },
  stuck: { final: 'stuck' },
});
