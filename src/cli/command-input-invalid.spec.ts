import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { CommandInputInvalid } from './command-input-invalid.js';

describe('command-input-invalid failures', () => {
  it('classifies CommandInputInvalid and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new CommandInputInvalid({ message });

    expect(error).toMatchObject({
      _tag: 'CommandInputInvalid',
      kind: 'fatal',
      message,
    });
  });
});
