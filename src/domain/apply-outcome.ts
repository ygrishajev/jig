import { panic } from 'better-result';

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
        verification: undefined,
      }));
    case 'verified':
      return updateCurrentSlice(state, (slice) => ({
        ...slice,
        lastFeedback: undefined,
        verification: outcome.command ? { command: outcome.command } : undefined,
      }));
    case 'described':
      return { ...state, prDescription: outcome.body };
    default:
      return state;
  }
}

export function updateCurrentSlice(state: RunState, update: (slice: Slice) => Slice): RunState {
  const target = currentSlice(state);
  if (!target) panic('No current slice to update');
  return {
    ...state,
    slices: state.slices.map((slice) => (slice.id === target.id ? update(slice) : slice)),
  };
}
