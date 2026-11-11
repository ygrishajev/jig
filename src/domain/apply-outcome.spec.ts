import { faker } from '@faker-js/faker';
import { Panic } from 'better-result';
import { describe, expect, it } from 'vitest';

import {
  aCommit,
  aContext,
  aDesignFinding,
  aDisposition,
  aFeaturePlan,
  anImplementation,
  aPlannedSlice,
  aRunState,
  aSlice,
  designDocs,
} from '../../tests/support/builders.js';
import { applyOutcome } from './apply-outcome.js';
import type { Outcome } from './outcome.js';
import { sliceSchema } from './slice.js';

describe('applyOutcome', () => {
  it.each(['continue', 'pause', 'approved', 'merged', 'awaitingManualMerge'] as const)(
    'preserves state for the %s control outcome',
    (type) => {
      const state = aRunState();
      expect(applyOutcome(state, { type })).toBe(state);
    },
  );

  it('records what the planning steps produced', () => {
    const context = aContext();
    const plan = aFeaturePlan();
    const docs = designDocs();

    let state = applyOutcome(aRunState(), { type: 'contextBuilt', context });
    state = applyOutcome(state, { type: 'featurePlanned', plan });
    state = applyOutcome(state, { type: 'designWritten', docs });

    expect(state).toMatchObject({ context, plan, docs });
  });

  it('folds the design review, the revision and the re-review into one record of the cycle', () => {
    const reviewedDocs = designDocs();
    const revisedDocs = designDocs();
    const findings = [aDesignFinding(), aDesignFinding()];
    const dispositions = findings.map((finding) => aDisposition(finding));
    const outstanding = [aDesignFinding()];

    let state = aRunState({ phase: 'reviewingDesign', docs: reviewedDocs });
    state = applyOutcome(state, { type: 'designReviewed', review: { findings } });
    state = applyOutcome(state, {
      type: 'designRevised',
      revision: { ...revisedDocs, dispositions },
    });
    state = applyOutcome(state, { type: 'designReviewed', review: { findings: outstanding } });

    expect(state.docs).toEqual(revisedDocs);
    expect(state.designReview).toEqual({
      reviews: [{ findings }, { findings: outstanding }],
      revision: { reviewedDocs, dispositions },
    });
  });

  it('turns planned slices into pending slices in the order they were planned', () => {
    const planned = [aPlannedSlice(), aPlannedSlice()];

    const { slices } = applyOutcome(aRunState(), { type: 'sliced', slices: planned });

    expect(slices).toEqual([
      {
        ...planned[0],
        order: 0,
        status: 'pending',
        reviewCycles: 0,
        emptyAttempts: 0,
        ruleFixCycles: 0,
        feedbackHistory: [],
      },
      {
        ...planned[1],
        order: 1,
        status: 'pending',
        reviewCycles: 0,
        emptyAttempts: 0,
        ruleFixCycles: 0,
        feedbackHistory: [],
      },
    ]);
  });

  it('counts a review cycle and keeps the feedback when changes are requested on the current slice', () => {
    const current = aSlice({ order: 0, reviewCycles: 1 });
    const later = aSlice({ order: 1 });
    const feedback = faker.lorem.sentence();

    const { slices } = applyOutcome(aRunState({ slices: [later, current] }), {
      type: 'changesRequested',
      feedback,
    });

    expect(slices.find((slice) => slice.id === current.id)).toMatchObject({
      reviewCycles: 2,
      lastFeedback: feedback,
    });
    expect(slices.find((slice) => slice.id === later.id)).toEqual(later);
  });

  it('counts an empty attempt, not a review cycle, when the implementation changed nothing', () => {
    const current = aSlice({ order: 0, reviewCycles: 1, emptyAttempts: 0 });
    const feedback = faker.lorem.sentence();

    const { slices } = applyOutcome(aRunState({ slices: [current] }), {
      type: 'nothingChanged',
      feedback,
    });

    expect(slices[0]).toMatchObject({ reviewCycles: 1, emptyAttempts: 1, lastFeedback: feedback });
  });

  it('counts a rule-fix round, not a review cycle, when only rule fixes are requested', () => {
    const current = aSlice({ order: 0, reviewCycles: 1, ruleFixCycles: 0 });
    const feedback = faker.lorem.sentence();

    const { slices } = applyOutcome(aRunState({ slices: [current] }), {
      type: 'rulesFixRequested',
      feedback,
    });

    expect(slices[0]).toMatchObject({ reviewCycles: 1, ruleFixCycles: 1, lastFeedback: feedback });
  });

  it('remembers the commit an implementation ended on', () => {
    const slice = aSlice({ order: 0, commit: faker.git.commitSha() });
    const commit = aCommit();

    const { slices } = applyOutcome(aRunState({ slices: [slice] }), anImplementation({ commit }));

    expect(slices[0].commit).toBe(commit.sha);
  });

  it('forgets earlier feedback once a slice is verified', () => {
    const first = faker.lorem.sentence();
    const second = faker.lorem.sentence();

    const { state } = setup({
      outcomes: [
        { type: 'changesRequested', feedback: first },
        { type: 'changesRequested', feedback: second },
        { type: 'verified' },
      ],
    });

    expect(state.slices[0].lastFeedback).toBeUndefined();
    expect(state.slices[0].feedbackHistory).toEqual([first, second]);
  });

  it('keeps every round of feedback in order as a slice is sent back again and again', () => {
    const first = faker.lorem.sentence();
    const second = faker.lorem.sentence();
    const third = faker.lorem.sentence();

    const { state } = setup({
      outcomes: [
        { type: 'changesRequested', feedback: first },
        { type: 'verified' },
        { type: 'rulesFixRequested', feedback: second },
        { type: 'nothingChanged', feedback: third },
      ],
    });

    expect(state.slices[0].feedbackHistory).toEqual([first, second, third]);
  });

  it('records the verify command the current slice passed once it is verified', () => {
    const command = `npm run ${faker.word.verb()}`;
    const slice = aSlice({ order: 0, status: 'verifying' });

    const { slices } = applyOutcome(aRunState({ slices: [slice] }), { type: 'verified', command });

    expect(slices[0].verification).toEqual({ command });
  });

  it('records no verification when a slice is verified without a command', () => {
    const slice = aSlice({ order: 0, status: 'verifying' });

    const { slices } = applyOutcome(aRunState({ slices: [slice] }), { type: 'verified' });

    expect(slices[0].verification).toBeUndefined();
  });

  it('forgets an earlier verification when changes are requested on the current slice', () => {
    const slice = aSlice({
      order: 0,
      status: 'verifying',
      verification: { command: `npm run ${faker.word.verb()}` },
    });

    const { slices } = applyOutcome(aRunState({ slices: [slice] }), {
      type: 'changesRequested',
      feedback: faker.lorem.sentence(),
    });

    expect(slices[0].verification).toBeUndefined();
  });

  it('still parses a slice saved before slices recorded their verification', () => {
    const { verification: _neverSaved, ...old } = aSlice();

    expect(sliceSchema.parse(old)).toEqual(old);
  });

  it('skips approved slices when picking the slice an outcome belongs to', () => {
    const approved = aSlice({ order: 0, status: 'approved' });
    const current = aSlice({ order: 1, reviewCycles: 0 });

    const { slices } = applyOutcome(aRunState({ slices: [approved, current] }), {
      type: 'changesRequested',
      feedback: faker.lorem.sentence(),
    });

    expect(slices[0]).toEqual(approved);
    expect(slices[1].reviewCycles).toBe(1);
  });

  it('keeps the pull request description', () => {
    const body = faker.lorem.paragraphs();

    expect(applyOutcome(aRunState(), { type: 'described', body }).prDescription).toBe(body);
  });

  it('refuses a slice outcome when no slice is left', () => {
    expect(() => applyOutcome(aRunState({ slices: [] }), { type: 'verified' })).toThrow(Panic);
  });

  function setup(input: { outcomes: Outcome[] }) {
    let state = aRunState({ slices: [aSlice({ order: 0 })] });
    for (const outcome of input.outcomes) {
      state = applyOutcome(state, outcome);
    }
    return { state };
  }
});
