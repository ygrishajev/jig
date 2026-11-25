import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aFailedVerification, aSlice } from '../../tests/support/builders.js';
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
  it('loads the failed verification a slice recorded with its output and the work around it', () => {
    const failedVerification = aFailedVerification();

    const parsed = sliceSchema.parse({ ...aSlice(), failedVerification });

    expect(parsed.failedVerification).toEqual(failedVerification);
  });
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
