import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aSlice } from '../../tests/support/builders.js';
import { sliceSchema, slicesInOrder } from './slice.js';

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
  it('loads a slice saved before empty attempts were counted as having none', () => {
    const { emptyAttempts: _dropped, ...saved } = aSlice();

    expect(sliceSchema.parse(saved).emptyAttempts).toBe(0);
  });
});
