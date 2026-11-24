import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { ConfigInvalid, GithubSettingsInvalid } from './errors.js';

describe('ConfigInvalid', () => {
  it('aborts on a configuration that does not validate', () => {
    const failure = new ConfigInvalid({ message: faker.lorem.sentence() });

    expect(failure).toMatchObject({ kind: 'fatal', _tag: 'ConfigInvalid' });
  });
});

describe('GithubSettingsInvalid', () => {
  it('carries its own tag', () => {
    const failure = new GithubSettingsInvalid({ message: faker.lorem.sentence() });

    expect(failure._tag).toBe('GithubSettingsInvalid');
  });
});
