import { faker } from '@faker-js/faker';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { createTempRepo } from '../../tests/support/temp-repo.js';
import { ConfigInvalid } from '../domain/errors.js';
import { deleteBranch, getCurrentBranch } from './branch.js';

describe('getCurrentBranch', () => {
  it('reports the branch checked out in the repository', async () => {
    const { repo, branch } = await setup();

    expect((await getCurrentBranch(repo)).unwrap()).toBe(branch);
  });

  it('reports a detached HEAD as something the operator fixes', async () => {
    const { repo } = await setup();
    await simpleGit({ baseDir: repo }).checkout(['--detach', 'HEAD']);

    const result = await getCurrentBranch(repo);

    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(result.isErr() && result.error.message).toBe(
      `${repo} has no branch checked out — check out the branch the run should start from.`,
    );
  });

  async function setup() {
    const { dir } = await createTempRepo();
    const branch = `${faker.word.noun()}-${faker.string.alphanumeric({ length: 6, casing: 'lower' })}`;
    await simpleGit({ baseDir: dir }).checkoutLocalBranch(branch);
    return { repo: dir, branch };
  }
});

describe('deleteBranch', () => {
  it('removes a branch that was never merged, and leaves a missing one alone', async () => {
    const { dir } = await createTempRepo();
    const git = simpleGit({ baseDir: dir });
    const branch = `${faker.word.noun()}-${faker.string.alphanumeric({ length: 6, casing: 'lower' })}`;
    const start = (await getCurrentBranch(dir)).unwrap();
    await git.checkoutLocalBranch(branch);
    await git.commit(faker.git.commitMessage(), { '--allow-empty': null });
    await git.checkout(start);

    expect((await deleteBranch(dir, branch)).isOk()).toBe(true);
    expect((await deleteBranch(dir, branch)).isOk()).toBe(true);

    expect((await git.branchLocal()).all).not.toContain(branch);
  });
});
