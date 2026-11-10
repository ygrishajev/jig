import { panic } from 'better-result';

import { recordFinalCheck } from './final-check.js';
import type { Outcome } from './outcome.js';
import { currentSlice, type RunState } from './run-state.js';
import { type Slice, sliceFromPlan } from './slice.js';

/**
 * Folds a step's outcome into run state. Only data changes here — which phase or slice
 * status comes next is the flow's decision, not this reducer's.
 */
export function applyOutcome(state: RunState, outcome: Outcome): RunState {
  if (isSendBack(outcome)) return sendSliceBack(state, outcome);
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
    case 'verified':
      return updateCurrentSlice(state, (slice) => ({
        ...slice,
        lastFeedback: undefined,
        verification: outcome.command ? { command: outcome.command } : undefined,
      }));
    case 'finalChecked':
      return recordFinalCheck(state, outcome);
    case 'described':
      return { ...state, prDescription: outcome.body };
    default:
      return state;
  }
}

function isSendBack(outcome: Outcome): outcome is SendBack {
  return outcome.type in ATTEMPT_COUNTER_OF;
}

/** Each way a slice goes back to its implementer counts against its own cap. */
const ATTEMPT_COUNTER_OF = {
  changesRequested: 'reviewCycles',
  nothingChanged: 'emptyAttempts',
  rulesFixRequested: 'ruleFixCycles',
} as const satisfies Partial<Record<Outcome['type'], keyof Slice>>;

type SendBack = Extract<Outcome, { type: keyof typeof ATTEMPT_COUNTER_OF }>;

function sendSliceBack(state: RunState, outcome: SendBack): RunState {
  const counter = ATTEMPT_COUNTER_OF[outcome.type];
  return updateCurrentSlice(state, (slice) => ({
    ...slice,
    [counter]: slice[counter] + 1,
    lastFeedback: outcome.feedback,
    feedbackHistory: [...slice.feedbackHistory, outcome.feedback],
    verification: undefined,
  }));
}

export function updateCurrentSlice(state: RunState, update: (slice: Slice) => Slice): RunState {
  const target = currentSlice(state);
  if (!target) panic('No current slice to update');
  return {
    ...state,
    slices: state.slices.map((slice) => (slice.id === target.id ? update(slice) : slice)),
  };
}
