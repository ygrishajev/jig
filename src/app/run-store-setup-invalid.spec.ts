import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { RunStoreSetupInvalid } from './run-store-setup-invalid.js';

describe('run-store-setup-invalid failures', () => {
  it('classifies RunStoreSetupInvalid and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new RunStoreSetupInvalid({ message });

    expect(error).toMatchObject({
      _tag: 'ConfigInvalid',
      kind: 'fatal',
      message,
    });
  });
});
