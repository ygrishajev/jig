import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { ConfigInvalid } from './errors.js';

describe('configuration failures', () => {
  it('classifies ConfigInvalid and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new ConfigInvalid({ message });

    expect(error).toMatchObject({
      _tag: 'ConfigInvalid',
      kind: 'fatal',
      message,
    });
  });
});
