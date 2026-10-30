import { faker } from '@faker-js/faker';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { getCurrentBranch } from './branch.js';

describe('getCurrentBranch', () => {
  it('reports the branch checked out in the repository', async () => {
    const { repo, branch } = await setup();

    expect(await getCurrentBranch(repo)).toBe(branch);
  });

  async function setup() {
    const { dir } = await createTempRepo();
    const branch = `${faker.word.noun()}-${faker.string.alphanumeric({ length: 6, casing: 'lower' })}`;
    await simpleGit({ baseDir: dir }).checkoutLocalBranch(branch);
    return { repo: dir, branch };
  }
});
