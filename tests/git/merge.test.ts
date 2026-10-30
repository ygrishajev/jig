import { afterEach, describe, expect, it } from 'vitest';
import { faker } from '@faker-js/faker';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { isBranchMergedInto, mergeBranchInto } from '../../src/git/merge.js';
import { commitAll } from '../../src/git/repository.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('mergeBranchInto and isBranchMergedInto', () => {
  it('merges a clean branch and reports it as merged', async () => {
    repo = await createTempRepo();
    await simpleGit({ baseDir: repo.dir }).checkoutBranch('feature/m', 'main');
    await writeFile(path.join(repo.dir, 'm.txt'), 'hi');
    await commitAll(repo.dir, 'add m.txt');
    await simpleGit({ baseDir: repo.dir }).checkout('main');
    expect(await isBranchMergedInto(repo.dir, 'feature/m', 'main')).toBe(false);
    const sha = await mergeBranchInto(repo.dir, 'feature/m', 'main');
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await isBranchMergedInto(repo.dir, 'feature/m', 'main')).toBe(true);
  });

  it('refuses to merge when the target branch is not checked out', async () => {
    repo = await createTempRepo();
    await simpleGit({ baseDir: repo.dir }).checkoutBranch('feature/n', 'main');
    await writeFile(path.join(repo.dir, 'n.txt'), 'hi');
    await commitAll(repo.dir, 'add n.txt');
    await expect(mergeBranchInto(repo.dir, 'feature/n', 'main')).rejects.toThrow(/not checked out/);
  });

  it('refuses to merge with a dirty working tree', async () => {
    repo = await createTempRepo();
    await simpleGit({ baseDir: repo.dir }).checkoutBranch('feature/o', 'main');
    await writeFile(path.join(repo.dir, 'o.txt'), 'hi');
    await commitAll(repo.dir, 'add o.txt');
    await simpleGit({ baseDir: repo.dir }).checkout('main');
    await writeFile(path.join(repo.dir, 'dirty.txt'), 'uncommitted');
    await expect(mergeBranchInto(repo.dir, 'feature/o', 'main')).rejects.toThrow(
      /uncommitted changes/,
    );
  });

  it('throws a plain git error when the branches actually conflict', async () => {
    repo = await createTempRepo();
    await simpleGit({ baseDir: repo.dir }).checkoutBranch('feature/p', 'main');
    await writeFile(path.join(repo.dir, 'README.md'), 'from branch\n');
    await commitAll(repo.dir, 'change readme on branch');
    await simpleGit({ baseDir: repo.dir }).checkout('main');
    await writeFile(path.join(repo.dir, 'README.md'), 'from main\n');
    await commitAll(repo.dir, 'change readme on main');
    await expect(mergeBranchInto(repo.dir, 'feature/p', 'main')).rejects.toThrow();
  });
});

describe('isBranchMergedInto', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it.each(['plain', 'squash', 'rebase'] as const)(
    'sees the branch once the base took it in a %s merge',
    async (strategy) => {
      const { here, branch, mergeOnRemote, pullBase } = await setup();
      await mergeOnRemote(strategy);
      await pullBase();

      expect(await isBranchMergedInto(here, branch, 'main')).toBe(true);
    },
  );

  it('sees a merge that only the remote base has, before the local base is pulled', async () => {
    const { here, branch, mergeOnRemote } = await setup();
    await mergeOnRemote('squash');

    expect(await isBranchMergedInto(here, branch, 'main')).toBe(true);
  });

  it('does not see a branch whose changes are not in the base', async () => {
    const { here, branch, advanceRemoteBase, pullBase } = await setup();
    await advanceRemoteBase();
    await pullBase();

    expect(await isBranchMergedInto(here, branch, 'main')).toBe(false);
  });

  it('does not see a branch that would conflict with the base', async () => {
    const { here, branch, rewriteBranchFilesOnRemote, pullBase } = await setup();
    await rewriteBranchFilesOnRemote();
    await pullBase();

    expect(await isBranchMergedInto(here, branch, 'main')).toBe(false);
  });

  it('counts a branch with no commits of its own as merged, since nothing is left to land', async () => {
    const { here } = await setup();
    const empty = `${faker.word.noun()}-${faker.string.alphanumeric(6).toLowerCase()}`;
    await simpleGit({ baseDir: here }).branch([empty, 'main']);

    expect(await isBranchMergedInto(here, empty, 'main')).toBe(true);
  });

  it('fails rather than answering for a branch that does not exist', async () => {
    const { here } = await setup();

    await expect(isBranchMergedInto(here, faker.string.uuid(), 'main')).rejects.toThrow();
  });

  async function setup() {
    const seed = await createTempRepo();
    const origin = await mkdtemp(path.join(tmpdir(), 'sdlc-origin-'));
    cleanups.push(seed.cleanup, () => rm(origin, { recursive: true, force: true }));
    await simpleGit().clone(seed.dir, origin, ['--bare']);
    const here = await cloneOf(origin);
    const elsewhere = await cloneOf(origin);
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
    return { here, branch, mergeOnRemote, advanceRemoteBase, rewriteBranchFilesOnRemote, pullBase };
  }

  async function cloneOf(origin: string) {
    const directory = await mkdtemp(path.join(tmpdir(), 'sdlc-clone-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await simpleGit().clone(origin, directory);
    const git = simpleGit({ baseDir: directory });
    await git.addConfig('user.email', faker.internet.email());
    await git.addConfig('user.name', faker.person.fullName());
    await git.addConfig('commit.gpgsign', 'false');
    await git.addConfig('pull.rebase', 'false');
    return directory;
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
