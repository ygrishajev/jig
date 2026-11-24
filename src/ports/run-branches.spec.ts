import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { RunBranchUnpublishable } from './run-branches.js';

describe('RunBranchUnpublishable', () => {
  it('carries its own tag', () => {
    const failure = new RunBranchUnpublishable({ message: faker.lorem.sentence() });

    expect(failure._tag).toBe('RunBranchUnpublishable');
  });
});
