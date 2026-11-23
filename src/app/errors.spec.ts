import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { RunRequestInvalid } from './errors.js';

describe('RunRequestInvalid', () => {
  it('aborts on a request a run cannot use', () => {
    const failure = new RunRequestInvalid({ message: faker.lorem.sentence() });

    expect(failure).toMatchObject({ kind: 'fatal', _tag: 'RunRequestInvalid' });
  });
});
