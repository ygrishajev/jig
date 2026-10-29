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
  | { type: 'implemented'; commit: CommitSummary | null }
  | { type: 'approved' }
  | { type: 'changesRequested'; feedback: string }
  | { type: 'verified' }
  | { type: 'described'; body: string }
  | { type: 'merged' }
  | { type: 'awaitingManualMerge' };

export type OutcomeType = Outcome['type'];
