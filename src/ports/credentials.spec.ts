import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { CodexLoginNotSaved, CredentialsInvalid } from './credentials.js';

describe('credentials failures', () => {
  it('classifies CodexLoginNotSaved and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new CodexLoginNotSaved({ message });

    expect(error).toMatchObject({
      _tag: 'CodexLoginNotSaved',
      kind: 'fatal',
      message,
    });
  });

  it('classifies CredentialsInvalid and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new CredentialsInvalid({ message });

    expect(error).toMatchObject({
      _tag: 'ConfigInvalid',
      kind: 'fatal',
      message,
    });
  });
});
