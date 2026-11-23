import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { repositoryIdentitySchema } from './repository-identity.js';

describe('repositoryIdentitySchema', () => {
  it('splits owner/repo into its owner and repository', () => {
    const owner = `${faker.string.alpha(6)}.${faker.string.alphanumeric(4)}`;
    const repo = `${faker.string.alpha(6)}-${faker.string.alphanumeric(4)}_x`;

    expect(repositoryIdentitySchema.parse(`${owner}/${repo}`)).toEqual({ owner, repo });
  });

  it.each(['../x/y', 'owner', 'owner/repo/extra', 'owner/', '/repo', 'own er/repo', ''])(
    'refuses "%s"',
    (raw) => {
      expect(repositoryIdentitySchema.safeParse(raw).success).toBe(false);
    },
  );
});
