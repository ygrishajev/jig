import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import {
  aCommit,
  anImplementation,
  aContext,
  aFeaturePlan,
  aPlannedSlice,
  aRunState,
  aSlice,
  designDocs,
} from '../../tests/support/builders.js';
import { applyOutcome } from './apply-outcome.js';

describe('applyOutcome', () => {
  it('records what the planning steps produced', () => {
    const context = aContext();
    const plan = aFeaturePlan();
    const docs = designDocs();

    let state = applyOutcome(aRunState(), { type: 'contextBuilt', context });
    state = applyOutcome(state, { type: 'featurePlanned', plan });
    state = applyOutcome(state, { type: 'designWritten', docs });

    expect(state).toMatchObject({ context, plan, docs });
  });

  it('turns planned slices into pending slices in the order they were planned', () => {
    const planned = [aPlannedSlice(), aPlannedSlice()];

    const { slices } = applyOutcome(aRunState(), { type: 'sliced', slices: planned });

    expect(slices).toEqual([
      { ...planned[0], order: 0, status: 'pending', reviewCycles: 0 },
      { ...planned[1], order: 1, status: 'pending', reviewCycles: 0 },
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

  it('remembers the commit an implementation ended on', () => {
    const slice = aSlice({ order: 0, commit: faker.git.commitSha() });
    const commit = aCommit();

    const { slices } = applyOutcome(aRunState({ slices: [slice] }), anImplementation({ commit }));

    expect(slices[0].commit).toBe(commit.sha);
  });

  it('forgets earlier feedback once a slice is verified', () => {
    const slice = aSlice({ order: 0, status: 'verifying', lastFeedback: faker.lorem.sentence() });

    const { slices } = applyOutcome(aRunState({ slices: [slice] }), { type: 'verified' });

    expect(slices[0].lastFeedback).toBeUndefined();
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
    expect(() => applyOutcome(aRunState({ slices: [] }), { type: 'verified' })).toThrow(
      'No current slice',
    );
  });
});
