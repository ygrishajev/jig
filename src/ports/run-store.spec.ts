import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { RunStoreOperationFailed } from './run-store.js';

describe('RunStoreOperationFailed', () => {
  it('aborts on a store module that threw', () => {
    const failure = new RunStoreOperationFailed({ message: faker.lorem.sentence() });

    expect(failure).toMatchObject({ kind: 'fatal', _tag: 'RunStoreOperationFailed' });
  });
});
