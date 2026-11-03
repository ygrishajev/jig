import { faker } from '@faker-js/faker';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type SimpleGit, simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { createRemote, createTempRepo } from '../../tests/support/temp-repo.js';
import { GitCommandFailed, MergeFailed, RemoteUnavailable } from '../domain/errors.js';
import { isBranchMergedInto, mergeBranchInto } from './merge.js';
import { commitAll } from './repository.js';

describe('mergeBranchInto', () => {
  it('merges a branch into the checked-out base and returns the merge commit', async () => {
    const { repo, branch, git } = await setup();

    const sha = (await mergeBranchInto(repo, branch, 'main')).unwrap();

    expect(sha).toBe(await git.revparse(['main']));
    expect((await isBranchMergedInto(repo, branch, 'main')).unwrap()).toBe(true);
  });

  it('refuses to merge while the base is not checked out, leaving the branches as they were', async () => {
    const { repo, branch, git } = await setup();
    await git.checkout(branch);
    const base = await git.revparse(['main']);

    const refusal = await mergeBranchInto(repo, branch, 'main');

    expect(refusal.isErr() && refusal.error).toBeInstanceOf(MergeFailed);
    expect(refusal.isErr() && refusal.error.message).toContain('is not checked out');
    expect(await git.revparse(['main'])).toBe(base);
    expect(await git.revparse(['HEAD'])).toBe(await git.revparse([branch]));
  });

  it('refuses to merge into a tree with uncommitted changes', async () => {
    const { repo, branch, git } = await setup();
    await writeFile(path.join(repo, `${faker.string.uuid()}.txt`), faker.lorem.paragraph());
    const base = await git.revparse(['main']);

    const refusal = await mergeBranchInto(repo, branch, 'main');

    expect(refusal.isErr() && refusal.error).toBeInstanceOf(MergeFailed);
    expect(refusal.isErr() && refusal.error.message).toContain('uncommitted changes');
    expect(await git.revparse(['main'])).toBe(base);
    expect((await git.status()).isClean()).toBe(false);
  });

  it('fails the merge when the branches conflict', async () => {
    const { repo, branch, git } = await setup({ touching: 'README.md' });
    await writeFile(path.join(repo, 'README.md'), faker.lorem.paragraph());
    await commitAll(repo, faker.git.commitMessage());

    const failure = await mergeBranchInto(repo, branch, 'main');

    expect(failure.isErr() && failure.error).toBeInstanceOf(MergeFailed);
    expect((await isBranchMergedInto(repo, branch, 'main')).unwrap()).toBe(false);
    await git.merge(['--abort']);
  });

  async function setup(input: { touching?: string } = {}) {
    const { dir } = await createTempRepo();
    const git = simpleGit({ baseDir: dir });
    const branch = `feature/${faker.string.alphanumeric({ length: 8, casing: 'lower' })}`;
    await git.checkoutLocalBranch(branch);
    await writeFile(
      path.join(dir, input.touching ?? `${faker.string.uuid()}.txt`),
      faker.lorem.paragraph(),
    );
    await commitAll(dir, faker.git.commitMessage());
    await git.checkout('main');
    return { repo: dir, branch, git };
  }
});

describe('isBranchMergedInto', () => {
  it.each(['plain', 'squash', 'rebase'] as const)(
    'sees the branch once the base took it in a %s merge',
    async (strategy) => {
      const { here, branch, mergeOnRemote, pullBase } = await setup();
      await mergeOnRemote(strategy);
      await pullBase();

      expect((await isBranchMergedInto(here, branch, 'main')).unwrap()).toBe(true);
    },
  );

  it('sees a merge that only the remote base has, before the local base is pulled', async () => {
    const { here, branch, mergeOnRemote } = await setup();
    await mergeOnRemote('squash');

    expect((await isBranchMergedInto(here, branch, 'main')).unwrap()).toBe(true);
  });

  it('does not see a branch whose changes are not in the base', async () => {
    const { here, branch, advanceRemoteBase, pullBase } = await setup();
    await advanceRemoteBase();
    await pullBase();

    expect((await isBranchMergedInto(here, branch, 'main')).unwrap()).toBe(false);
  });

  it('does not see a branch that would conflict with the base', async () => {
    const { here, branch, rewriteBranchFilesOnRemote, pullBase } = await setup();
    await rewriteBranchFilesOnRemote();
    await pullBase();

    expect((await isBranchMergedInto(here, branch, 'main')).unwrap()).toBe(false);
  });

  it('counts a branch with no commits of its own as merged, since nothing is left to land', async () => {
    const { here } = await setup();
    const empty = `${faker.word.noun()}-${faker.string.alphanumeric(6).toLowerCase()}`;
    await simpleGit({ baseDir: here }).branch([empty, 'main']);

    expect((await isBranchMergedInto(here, empty, 'main')).unwrap()).toBe(true);
  });

  it('reports a remote it cannot reach as unavailable rather than answering', async () => {
    const { here, branch, loseRemote } = await setup();
    await loseRemote();

    const answer = await isBranchMergedInto(here, branch, 'main');

    expect(answer.isErr() && answer.error).toBeInstanceOf(RemoteUnavailable);
  });

  it('fails rather than answering for a branch that does not exist', async () => {
    const { here } = await setup();

    const answer = await isBranchMergedInto(here, faker.string.uuid(), 'main');

    expect(answer.isErr() && answer.error).toBeInstanceOf(GitCommandFailed);
  });

  async function setup() {
    const { origin, cloneOf } = await createRemote();
    const here = await cloneOf();
    const elsewhere = await cloneOf();
    const branch = `run/${faker.string.alphanumeric(8).toLowerCase()}`;
    await commitTwiceOnNewBranch(here, branch);
    await simpleGit({ baseDir: here }).push('origin', branch);

    const remote = simpleGit({ baseDir: elsewhere });
    const advanceRemoteBase = async () => {
      await commitFile(elsewhere);
      await remote.push('origin', 'main');
    };
    const mergeOnRemote = async (strategy: keyof typeof mergeStrategies) => {
      await remote.fetch('origin', branch);
      await commitFile(elsewhere);
      await mergeStrategies[strategy](remote, `origin/${branch}`);
      await remote.push('origin', 'main');
    };
    const rewriteBranchFilesOnRemote = async () => {
      const changed = await simpleGit({ baseDir: here }).diff(['--name-only', `main...${branch}`]);
      for (const file of changed.trim().split('\n')) {
        await writeFile(path.join(elsewhere, file), faker.lorem.paragraph());
      }
      await commitAll(elsewhere, faker.git.commitMessage());
      await remote.push('origin', 'main');
    };
    const pullBase = () => simpleGit({ baseDir: here }).pull('origin', 'main');
    const loseRemote = () => rm(origin, { recursive: true, force: true });
    return {
      here,
      branch,
      mergeOnRemote,
      advanceRemoteBase,
      rewriteBranchFilesOnRemote,
      pullBase,
      loseRemote,
    };
  }
});

const mergeStrategies = {
  plain: (git: SimpleGit, branch: string) => git.merge(['--no-ff', '--no-edit', branch]),
  squash: async (git: SimpleGit, branch: string) => {
    await git.merge(['--squash', branch]);
    await git.commit(faker.git.commitMessage());
  },
  rebase: async (git: SimpleGit, branch: string) => {
    const rebased = `rebased-${faker.string.alphanumeric(6).toLowerCase()}`;
    await git.checkoutBranch(rebased, branch);
    await git.rebase(['main']);
    await git.checkout('main');
    await git.merge(['--ff-only', rebased]);
  },
};

async function commitTwiceOnNewBranch(repo: string, branch: string) {
  await simpleGit({ baseDir: repo }).checkoutLocalBranch(branch);
  await commitFile(repo);
  await commitFile(repo);
  await simpleGit({ baseDir: repo }).checkout('main');
}

async function commitFile(repo: string) {
  await writeFile(path.join(repo, `${faker.string.uuid()}.txt`), faker.lorem.paragraph());
  await commitAll(repo, faker.git.commitMessage());
}
