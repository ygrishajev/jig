import { z } from 'zod';

import type { DesignDocs } from './design-docs.js';
import type { DesignReview, DesignRevision } from './design-review.js';
import type { FeaturePlan, RunContext } from './run-state.js';
import type { PlannedSlice } from './slice.js';
import type { CommitSummary } from './usage.js';

export type OutcomeType = Outcome['type'];

/** What a step reports back. Steps never change state; the engine applies their outcome. */
export type Outcome = OfKnownType<
  | { type: 'contextBuilt'; context: RunContext }
  | { type: 'featurePlanned'; plan: FeaturePlan }
  | { type: 'designWritten'; docs: DesignDocs }
  | { type: 'designReviewed'; review: DesignReview }
  | { type: 'designRevised'; revision: DesignRevision }
  | { type: 'sliced'; slices: PlannedSlice[] }
  | { type: 'continue' }
  | { type: 'pause' }
  | { type: 'implemented'; commit: CommitSummary }
  | { type: 'approved' }
  | { type: 'changesRequested'; feedback: string }
  | { type: 'nothingChanged'; feedback: string }
  | { type: 'rulesFixRequested'; feedback: string }
  | { type: 'verified'; command?: string }
  | {
      type: 'finalChecked';
      verified: boolean;
      command?: string;
      output?: string;
      fulfilled: boolean;
      gaps: string[];
    }
  | { type: 'described'; body: string }
  | { type: 'merged' }
  | { type: 'awaitingManualMerge' }
>;

export const outcomeTypeSchema = z.enum([
  'contextBuilt',
  'featurePlanned',
  'designWritten',
  'designReviewed',
  'designRevised',
  'sliced',
  'continue',
  'pause',
  'implemented',
  'approved',
  'changesRequested',
  'nothingChanged',
  'rulesFixRequested',
  'verified',
  'finalChecked',
  'described',
  'merged',
  'awaitingManualMerge',
]) satisfies z.ZodType<Outcome['type']>;

/** Every outcome's type must be one `outcomeTypeSchema` knows, so the two cannot drift apart. */
type OfKnownType<T extends { type: z.infer<typeof outcomeTypeSchema> }> = T;
