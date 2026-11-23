import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { ConfigInvalid } from './errors.js';

describe('ConfigInvalid', () => {
  it('aborts on a configuration that does not validate', () => {
    const failure = new ConfigInvalid({ message: faker.lorem.sentence() });

    expect(failure).toMatchObject({ kind: 'fatal', _tag: 'ConfigInvalid' });
  });
});
