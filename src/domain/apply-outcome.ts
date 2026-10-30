import type { Outcome } from './outcome.js';
import { currentSlice, type RunState } from './run-state.js';
import { type Slice, sliceFromPlan } from './slice.js';

/**
 * Folds a step's outcome into run state. Only data changes here — which phase or slice
 * status comes next is the flow's decision, not this reducer's.
 */
export function applyOutcome(state: RunState, outcome: Outcome): RunState {
  switch (outcome.type) {
    case 'contextBuilt':
      return { ...state, context: outcome.context };
    case 'featurePlanned':
      return { ...state, plan: outcome.plan };
    case 'designWritten':
      return { ...state, docs: outcome.docs };
    case 'sliced':
      return { ...state, slices: outcome.slices.map(sliceFromPlan) };
    case 'implemented':
      return updateCurrentSlice(state, (slice) => ({
        ...slice,
        commit: outcome.commit.sha,
      }));
    case 'changesRequested':
      return updateCurrentSlice(state, (slice) => ({
        ...slice,
        reviewCycles: slice.reviewCycles + 1,
        lastFeedback: outcome.feedback,
      }));
    case 'verified':
      return updateCurrentSlice(state, (slice) => ({ ...slice, lastFeedback: undefined }));
    case 'described':
      return { ...state, prDescription: outcome.body };
    case 'continue':
    case 'pause':
    case 'approved':
    case 'merged':
    case 'awaitingManualMerge':
      return state;
  }
}

/** A slice outcome arrived for a run with every slice already settled: a bug in the flow. */
export class NoCurrentSlice extends Error {
  constructor() {
    super('No current slice to update');
  }
}

export function updateCurrentSlice(state: RunState, update: (slice: Slice) => Slice): RunState {
  const target = currentSlice(state);
  if (!target) throw new NoCurrentSlice();
  return {
    ...state,
    slices: state.slices.map((slice) => (slice.id === target.id ? update(slice) : slice)),
  };
}
