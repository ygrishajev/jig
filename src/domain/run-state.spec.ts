import { faker } from '@faker-js/faker';
import { Panic } from 'better-result';
import { describe, expect, it } from 'vitest';

import {
  aCompletionEvidence,
  aFirstDesignReview,
  anApprovedDesignReview,
  aRevisedDesignReview,
  aRevisionAwaitingReReview,
  aRunState,
  aSlice,
  runId,
} from '../../tests/support/builders.js';
import type { DesignReviewProgress } from './design-review.js';
import {
  canRecoverInitialCheckpoint,
  enterPhase,
  runMerges,
  type RunPhase,
  runPhaseSchema,
  runStateSchema,
  startRun,
  stuckSlice,
} from './run-state.js';
import { sliceStatusSchema } from './slice.js';

/** The phases a run reaches once its design review is settled. */
const PHASES_PAST_DESIGN_REVIEW = [
  'slicing',
  'gate',
  'paused',
  'slices',
  'checkingReuse',
  'finalCheck',
  'describing',
  'merging',
  'awaitingMerge',
  'completed',
  'done',
  'stuck',
] as const satisfies readonly RunPhase[];

describe('runStateSchema', () => {
  it.each(runPhaseSchema.options)('loads a run saved in phase %s', (phase) => {
    const state = aRunState({ phase });

    expect(runStateSchema.parse(state)).toEqual(state);
  });

  it.each([
    ['planning', 'context'],
    ['designing', 'plan'],
    ['reviewingDesign', 'docs'],
    ['revisingDesign', 'designReview'],
    ['resolvingDesign', 'designReview'],
    ['slicing', 'designReview'],
    ['stuck', 'designReview'],
    ['describing', 'docs'],
    ['done', 'prDescription'],
    ['completed', 'prDescription'],
  ] as const)('refuses a run saved in %s without its %s', (phase, missing) => {
    const { [missing]: _dropped, ...saved } = aRunState({ phase });

    expect(runStateSchema.safeParse(saved).success).toBe(false);
  });

  it.each(PHASES_PAST_DESIGN_REVIEW)(
    'loads a run saved in %s with its approved design review',
    (phase) => {
      const state = aRunState({ phase, designReview: anApprovedDesignReview() });

      expect(runStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    },
  );

  it.each(PHASES_PAST_DESIGN_REVIEW)(
    'refuses a run saved in %s whose design review left findings standing',
    (phase) => {
      const saved = { ...aRunState({ phase }), designReview: aRevisedDesignReview() };

      expect(runStateSchema.safeParse(saved).success).toBe(false);
    },
  );

  it.each([
    ['reviewingDesign', 'awaiting its re-review', aRevisionAwaitingReReview()],
    ['revisingDesign', 'awaiting its revision', aFirstDesignReview()],
    ['resolvingDesign', 'left findings standing', aRevisedDesignReview()],
  ] as const)('loads a run saved in %s whose design review %s', (phase, _stage, designReview) => {
    const state = aRunState({ phase, designReview });

    expect(runStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it.each<[RunPhase, string, DesignReviewProgress]>([
    ['reviewingDesign', 'a first review with no revision', aFirstDesignReview()],
    ['reviewingDesign', 'both reviews', aRevisedDesignReview()],
    ['revisingDesign', 'a first review that approved', { reviews: [{ findings: [] }] }],
    ['revisingDesign', 'the revision already made', aRevisionAwaitingReReview()],
    ['revisingDesign', 'both reviews', aRevisedDesignReview()],
    ['resolvingDesign', 'only the first review', aFirstDesignReview()],
    ['resolvingDesign', 'no re-review yet', aRevisionAwaitingReReview()],
    ['resolvingDesign', 'a re-review that approved', aRevisedDesignReview({ outstanding: [] })],
  ])('refuses a run saved in %s with %s', (phase, _record, designReview) => {
    const saved = { ...aRunState({ phase }), designReview };

    expect(runStateSchema.safeParse(saved).success).toBe(false);
  });

  it('pins the refusal on the design review, not the rest of the run', () => {
    const saved = {
      ...aRunState({ phase: 'resolvingDesign' }),
      designReview: aFirstDesignReview(),
    };

    const parsed = runStateSchema.safeParse(saved);

    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['designReview']]);
  });

  it('starts a run that merges unless told otherwise', () => {
    const started = startRun(aStart());

    expect(runMerges(started)).toBe(true);
  });

  it('keeps the choice not to merge from the start', () => {
    const started = startRun({ ...aStart(), merge: false });

    expect(runMerges(started)).toBe(false);
  });

  it('panics entering completed without a pull request description', () => {
    const { prDescription: _missing, ...undescribed } = aRunState({ phase: 'describing' });

    expect(() => enterPhase(undescribed, 'completed')).toThrow(Panic);
  });

  it('enters completed from a described run, keeping its description', () => {
    const prDescription = faker.lorem.paragraphs();
    const described = { ...aRunState({ phase: 'describing' }), prDescription };

    const completed = enterPhase(described, 'completed');

    expect(completed).toMatchObject({ phase: 'completed', prDescription });
  });

  it('loads a run saved in describing with what the earlier phases produced', () => {
    const state = aRunState({ phase: 'describing' });

    expect(runStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it.each(sliceStatusSchema.options)('loads a slice saved as %s', (status) => {
    const state = aRunState({ phase: 'slices', slices: [aSlice({ status })] });

    expect(runStateSchema.parse(state)).toEqual(state);
  });

  it('loads a run carrying the completion evidence of its combined slice review', () => {
    const state = aRunState({
      phase: 'slices',
      slices: [aSlice()],
      completionReuse: aCompletionEvidence(),
    });

    expect(runStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});

describe('stuckSlice', () => {
  it('finds the slice that hit the review cap', () => {
    const stuck = aSlice({ status: 'stuck' });
    const state = aRunState({ slices: [aSlice({ status: 'approved' }), stuck] });

    expect(stuckSlice(state)?.id).toBe(stuck.id);
  });

  it('finds none while every slice can still progress', () => {
    const statuses = sliceStatusSchema.options.filter((status) => status !== 'stuck');
    const state = aRunState({ slices: statuses.map((status) => aSlice({ status })) });

    expect(stuckSlice(state)).toBeUndefined();
  });
});

function aStart() {
  return {
    runId: runId(),
    baseBranch: 'main',
    request: faker.lorem.paragraph(),
  };
}

describe('canRecoverInitialCheckpoint', () => {
  it('accepts untouched state independently of persistence revision', () => {
    expect(canRecoverInitialCheckpoint(aRunState({ phase: 'context' }))).toBe(true);
  });

  it.each(runPhaseSchema.options.filter((phase) => phase !== 'context'))(
    'refuses progressed phase %s',
    (phase) => {
      expect(canRecoverInitialCheckpoint(aRunState({ phase }))).toBe(false);
    },
  );

  it.each([
    { slices: [aSlice()] },
    { context: { classification: faker.word.noun(), repoSummary: faker.lorem.paragraph() } },
    { diagnosticSequence: 1 },
    { blockedReason: faker.lorem.sentence() },
    { prDescription: faker.lorem.paragraph() },
    { completionReuseAuthorized: true as const },
    { plan: aRunState({ phase: 'designing' }).plan },
    { docs: aRunState({ phase: 'slicing' }).docs },
    { designReview: aFirstDesignReview() },
    { finalCheck: { verified: true, fulfilled: true, gaps: [], round: 1 } },
    { completionReuse: aCompletionEvidence() },
  ])('refuses ambiguous context state %j', (evidence) => {
    expect(canRecoverInitialCheckpoint(aRunState({ phase: 'context', ...evidence }))).toBe(false);
  });
});
