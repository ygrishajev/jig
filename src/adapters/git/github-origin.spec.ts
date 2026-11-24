import { faker } from '@faker-js/faker';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { githubOriginName } from './github-origin.js';

describe('githubOriginName', () => {
  it.each(['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'])(
    'reads an origin using %s',
    async (prefix) => {
      const { dir, name } = await setup();
      await simpleGit(dir).addRemote('origin', `${prefix}${name}.git`);

      expect(unwrap(await githubOriginName(dir))).toBe(name);
    },
  );

  it('reads an origin with a trailing slash and no .git suffix', async () => {
    const { dir, name } = await setup();
    await simpleGit(dir).addRemote('origin', `https://github.com/${name}/`);

    expect(unwrap(await githubOriginName(dir))).toBe(name);
  });

  it('names nothing for an origin outside GitHub', async () => {
    const { dir, name } = await setup();
    await simpleGit(dir).addRemote('origin', `https://${faker.internet.domainName()}/${name}.git`);

    expect(unwrap(await githubOriginName(dir))).toBeUndefined();
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
