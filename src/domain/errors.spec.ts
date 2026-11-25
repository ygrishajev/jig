import { describe, expect, it } from 'vitest';

import { type FailureKind, isTransient } from './errors.js';

describe('isTransient', () => {
  it.each<[FailureKind, boolean]>([
    ['retry', true],
    ['block', false],
    ['fatal', false],
  ])('treats a %s failure as worth another attempt: %s', (kind, transient) => {
    expect(isTransient({ kind })).toBe(transient);
  });
});
