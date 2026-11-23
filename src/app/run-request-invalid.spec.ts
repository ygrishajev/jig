import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { RunRequestInvalid } from './run-request-invalid.js';

describe('run-request-invalid failures', () => {
  it('classifies RunRequestInvalid and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new RunRequestInvalid({ message });

    expect(error).toMatchObject({
      _tag: 'RunRequestInvalid',
      kind: 'fatal',
      message,
    });
  });
});
