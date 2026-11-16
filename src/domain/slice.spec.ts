import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aSlice } from '../../tests/support/builders.js';
import { earlierFeedback, sliceSchema, slicesInOrder } from './slice.js';

describe('slicesInOrder', () => {
  it('lists slices by their planned order without reordering the input', () => {
    const { slices, ordered } = setup({ count: 5 });

    const listed = slicesInOrder(slices);

    expect(listed.map((slice) => slice.id)).toEqual(ordered.map((slice) => slice.id));
  });

  function setup(input: { count: number }) {
    const ordered = Array.from({ length: input.count }, (_, order) => aSlice({ order }));
    const slices = faker.helpers.shuffle([...ordered]);
    return { slices: Object.freeze(slices), ordered };
  }
});

describe('sliceSchema', () => {
  it('loads a slice saved before empty attempts and rule fixes were counted as having none', () => {
    const {
      emptyAttempts: _empty,
      ruleFixCycles: _ruleFixes,
      hookFailures: _hooks,
      verificationFailures: _verification,
      ...saved
    } = aSlice();

    expect(sliceSchema.parse(saved)).toMatchObject({
      emptyAttempts: 0,
      ruleFixCycles: 0,
      hookFailures: 0,
      verificationFailures: 0,
    });
  });

  it('loads a slice saved before feedback was kept as a history with none', () => {
    const { saved } = setup();

    expect(sliceSchema.parse(saved)).toMatchObject({ feedbackHistory: [] });
  });

  it('loads a verification saved before observations were recorded as one without them', () => {
    const command = `npm run ${faker.word.verb()}`;

    expect(sliceSchema.parse({ ...aSlice(), verification: { command } }).verification).toEqual({
      command,
    });
  });

  function setup() {
    const { feedbackHistory: _neverSaved, ...saved } = aSlice();
    return { saved };
  }
});

describe('earlierFeedback', () => {
  it('returns every round but the latest while the latest feedback is still to address', () => {
    const { history, slice } = setup();

    expect(earlierFeedback(slice)).toEqual(history.slice(0, -1));
  });

  it('returns the whole history once the latest feedback has been cleared', () => {
    const { history, slice } = setup({ verified: true });

    expect(earlierFeedback(slice)).toEqual(history);
  });

  function setup(input: { verified?: boolean } = {}) {
    const history = [faker.lorem.sentence(), faker.lorem.sentence(), faker.lorem.sentence()];
    const slice = aSlice({
      feedbackHistory: history,
      lastFeedback: input.verified ? undefined : history[2],
    });
    return { history, slice };
  }
});
