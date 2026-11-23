import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { DesignUnresolved, type FailureKind, isTransient, PlanNotCovered } from './errors.js';

describe('isTransient', () => {
  it.each<[FailureKind, boolean]>([
    ['retry', true],
    ['block', false],
    ['fatal', false],
  ])('treats a %s failure as worth another attempt: %s', (kind, transient) => {
    expect(isTransient({ kind })).toBe(transient);
  });
});

describe('business failures', () => {
  it('retries slices that do not cover the plan', () => {
    const failure = new PlanNotCovered({ message: faker.lorem.sentence() });

    expect(failure.kind).toBe('retry');
    expect(failure._tag).toBe('PlanNotCovered');
  });

  it('blocks on a design left unresolved and keeps its finding ids', () => {
    const findingIds = [faker.lorem.slug(), faker.lorem.slug()];

    const failure = new DesignUnresolved({ message: faker.lorem.sentence(), findingIds });

    expect(failure.kind).toBe('block');
    expect(failure._tag).toBe('DesignUnresolved');
    expect(failure.findingIds).toEqual(findingIds);
  });
});
