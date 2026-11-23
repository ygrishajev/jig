import { describe, expect, it } from 'vitest';

import { type FailureKind, isTransient } from './failure-policy.js';

describe('isTransient', () => {
  it.each<[FailureKind, boolean]>([
    ['retry', true],
    ['block', false],
    ['fatal', false],
  ])('retries %s failures: %s', (kind, expected) => expect(isTransient({ kind })).toBe(expected));
});
