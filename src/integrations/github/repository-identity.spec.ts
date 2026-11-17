import { faker } from '@faker-js/faker';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { repositoryIdentity } from './repository-identity.js';

describe('repositoryIdentity', () => {
  it.each(['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'])(
    'reads an origin using %s',
    async (prefix) => {
      const { dir, repository } = await setup();
      await simpleGit(dir).addRemote(
        'origin',
        `${prefix}${repository.owner}/${repository.repo}.git`,
      );
      expect(unwrap(await repositoryIdentity(dir, {}))).toEqual(repository);
    },
  );

  it('prefers the environment and refuses malformed identities', async () => {
    const { dir, repository } = await setup();
    expect(
      unwrap(
        await repositoryIdentity(dir, {
          GITHUB_REPOSITORY: `${repository.owner}/${repository.repo}`,
        }),
      ),
    ).toEqual(repository);
    expect((await repositoryIdentity(dir, { GITHUB_REPOSITORY: '../x/y' })).isErr()).toBe(true);
    expect((await repositoryIdentity(dir, {})).isErr()).toBe(true);
  });

  async function setup() {
    const { dir } = await createTempRepo();
    return { dir, repository: { owner: faker.string.alpha(10), repo: faker.string.alpha(10) } };
  }
});
