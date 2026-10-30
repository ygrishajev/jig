import { z } from 'zod';
import type { DesignDocs, FeaturePlan, RunContext } from './run-state.js';
import type { PlannedSlice } from './slice.js';
import type { CommitSummary } from './usage.js';

/** What a step reports back. Steps never change state; the engine applies their outcome. */
export type Outcome =
  | { type: 'contextBuilt'; context: RunContext }
  | { type: 'featurePlanned'; plan: FeaturePlan }
  | { type: 'designWritten'; docs: DesignDocs }
  | { type: 'sliced'; slices: PlannedSlice[] }
  | { type: 'continue' }
  | { type: 'pause' }
  | { type: 'implemented'; commit: CommitSummary }
  | { type: 'approved' }
  | { type: 'changesRequested'; feedback: string }
  | { type: 'verified' }
  | { type: 'described'; body: string }
  | { type: 'merged' }
  | { type: 'awaitingManualMerge' };

export type OutcomeType = Outcome['type'];

/** Every outcome type; a `Record` so the compiler fails when one is added to `Outcome` but not here. */
const OUTCOME_TYPES: Record<OutcomeType, true> = {
  contextBuilt: true,
  featurePlanned: true,
  designWritten: true,
  sliced: true,
  continue: true,
  pause: true,
  implemented: true,
  approved: true,
  changesRequested: true,
  verified: true,
  described: true,
  merged: true,
  awaitingManualMerge: true,
};

function isOutcomeType(value: unknown): value is OutcomeType {
  return typeof value === 'string' && Object.hasOwn(OUTCOME_TYPES, value);
}

export const outcomeTypeSchema = z.custom<OutcomeType>(isOutcomeType, {
  message: 'not an outcome a step reports',
});
