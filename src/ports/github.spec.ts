import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { GithubNotFound, GithubRefused, GithubSetupInvalid, GithubUnavailable } from './github.js';

describe('GitHub failures', () => {
  it.each([GithubUnavailable, GithubRefused, GithubNotFound, GithubSetupInvalid])(
    'tags %o with its own name',
    (Failure) => {
      const failure = new Failure({ message: faker.lorem.sentence() });

      expect(failure._tag).toBe(Failure.name);
    },
  );
});
