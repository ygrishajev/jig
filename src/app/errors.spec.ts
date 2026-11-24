import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { BaseBranchMismatch, RunRequestInvalid } from './errors.js';

describe('RunRequestInvalid', () => {
  it('aborts on a request a run cannot use', () => {
    const failure = new RunRequestInvalid({ message: faker.lorem.sentence() });

    expect(failure).toMatchObject({ kind: 'fatal', _tag: 'RunRequestInvalid' });
  });
});

describe('BaseBranchMismatch', () => {
  it('carries its own tag', () => {
    const failure = new BaseBranchMismatch({ message: faker.lorem.sentence() });

    expect(failure._tag).toBe('BaseBranchMismatch');
  });
});
