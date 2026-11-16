import { panic } from 'better-result';

import type { CompletionEvidence } from './completion-reuse.js';
import { recordDesignReview, recordDesignRevision } from './design-review.js';
import { recordFinalCheck } from './final-check.js';
import type { Outcome } from './outcome.js';
import { currentSlice, enterPhase, type RunState } from './run-state.js';
import { type Slice, sliceFromPlan } from './slice.js';

/**
 * Folds a step's outcome into run state. Only data changes here — which phase or slice
 * status comes next is the flow's decision, not this reducer's.
 */
export function applyOutcome(state: RunState, outcome: Outcome): RunState {
  if (isSendBack(outcome)) return sendSliceBack(state, outcome);
  if (isDesignOutcome(outcome)) return applyDesignOutcome(state, outcome);
  if (outcome.type === 'completionReused') return { ...state, completionReuseAuthorized: true };
  if (outcome.type === 'completionInvalidated') return revokeCompletionReuse(state);
  return foldStepData(state, outcome);
}

function isSendBack(outcome: Outcome): outcome is SendBack {
  return outcome.type in ATTEMPT_COUNTER_OF;
}

/** Each way a slice goes back to its implementer counts against its own cap. */
const ATTEMPT_COUNTER_OF = {
  changesRequested: 'reviewCycles',
  hookRejected: 'hookFailures',
  verificationFailed: 'verificationFailures',
  nothingChanged: 'emptyAttempts',
  rulesFixRequested: 'ruleFixCycles',
} as const satisfies Partial<Record<Outcome['type'], keyof Slice>>;

type SendBack = Extract<Outcome, { type: keyof typeof ATTEMPT_COUNTER_OF }> & {
  completion?: CompletionEvidence;
};

function sendSliceBack(state: RunState, outcome: SendBack): RunState {
  const counter = ATTEMPT_COUNTER_OF[outcome.type];
  return withCompletionEvidence(
    updateCurrentSlice(state, (slice) => ({
      ...slice,
      [counter]: slice[counter] + 1,
      lastFeedback: outcome.feedback,
      feedbackHistory: [...slice.feedbackHistory, outcome.feedback],
      verification: undefined,
      failedVerification: failedVerificationOf(outcome, slice),
    })),
    outcome.completion,
  );
}

/** The whole-request evidence a review leaves, kept as the run's record of its latest one. */
function withCompletionEvidence(
  state: RunState,
  completion: CompletionEvidence | undefined,
): RunState {
  if (completion === undefined && state.completionReuse === undefined) return state;
  return { ...state, completionReuse: completion };
}

export function updateCurrentSlice(state: RunState, update: (slice: Slice) => Slice): RunState {
  const target = currentSlice(state);
  if (!target) panic('No current slice to update');
  return {
    ...state,
    slices: state.slices.map((slice) => (slice.id === target.id ? update(slice) : slice)),
  };
}

/**
 * The facts of the verification that just failed, beside the counter it spent; a failure that
 * recorded none leaves whatever earlier failure the slice already holds.
 */
function failedVerificationOf(outcome: SendBack, slice: Slice): Slice['failedVerification'] {
  if (outcome.type !== 'verificationFailed') return slice.failedVerification;
  const { command, observed } = outcome;
  return command !== undefined && observed !== undefined
    ? { command, observed }
    : slice.failedVerification;
}

function isDesignOutcome(outcome: Outcome): outcome is DesignOutcome {
  return DESIGN_OUTCOME_TYPES.some((type) => type === outcome.type);
}

/** The outcomes that write, review and revise the design documents before slicing. */
const DESIGN_OUTCOME_TYPES = [
  'designWritten',
  'designReviewed',
  'designRevised',
] as const satisfies readonly Outcome['type'][];

type DesignOutcome = Extract<Outcome, { type: (typeof DESIGN_OUTCOME_TYPES)[number] }>;

function applyDesignOutcome(state: RunState, outcome: DesignOutcome): RunState {
  switch (outcome.type) {
    case 'designWritten':
      return { ...state, docs: outcome.docs };
    case 'designReviewed':
      return recordDesignReview(state, outcome.review);
    case 'designRevised':
      return recordDesignRevision(state, outcome.revision);
  }
}

/**
 * Withdraws the run's authority to finish on its evidence, with the description written from it,
 * and puts the run back in its final check, which still owes its one repair. The run leaves
 * finishing here because a phase past describing cannot hold a run without its description.
 */
function revokeCompletionReuse(state: RunState): RunState {
  const { completionReuseAuthorized: _authorized, prDescription: _described, ...revoked } = state;
  return enterPhase(revoked, 'finalCheck');
}

function foldStepData(state: RunState, outcome: Outcome): RunState {
  switch (outcome.type) {
    case 'contextBuilt':
      return { ...state, context: outcome.context };
    case 'featurePlanned':
      return { ...state, plan: outcome.plan };
    case 'sliced':
      return { ...state, slices: outcome.slices.map(sliceFromPlan) };
    case 'implemented':
      return updateCurrentSlice(state, (slice) => ({
        ...slice,
        commit: outcome.commit.sha,
      }));
    case 'verified':
      return updateCurrentSlice(state, (slice) => verifiedSlice(slice, outcome));
    case 'approved':
      return withCompletionEvidence(state, outcome.completion);
    case 'finalChecked':
      return recordFinalCheck(state, outcome);
    case 'described':
      return { ...state, prDescription: outcome.body };
    default:
      return state;
  }
}

/** What a passed verification leaves on the slice: its command, the work it ran on, and no feedback left to address. */
function verifiedSlice(slice: Slice, outcome: Extract<Outcome, { type: 'verified' }>): Slice {
  return {
    ...slice,
    lastFeedback: undefined,
    verification: outcome.command
      ? { command: outcome.command, observed: outcome.observed }
      : undefined,
  };
}
