import { faker } from '@faker-js/faker';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { githubOriginName } from './github-origin.js';

describe('githubOriginName', () => {
  it('reads the repository its origin names, if that is on GitHub', async () => {
    const { dir, name } = await setup();
    await simpleGit(dir).addRemote('origin', `git@github.com:${name}.git`);

    expect(unwrap(await githubOriginName(dir))).toBe(name);
  });

  it('refuses a clone without an origin', async () => {
    const { dir } = await setup();

    const result = await githubOriginName(dir);

    expect(result.isErr() && result.error._tag).toBe('GithubSetupInvalid');
  });

  async function setup() {
    const { dir } = await createTempRepo();
    return { dir, name: `${faker.string.alpha(10)}/${faker.string.alpha(10)}` };
  }
});
