import { faker } from '@faker-js/faker';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { ConfigInvalid } from '../domain/errors.js';
import { commitAll, ensureRepositoryRoot, isWorkingTreeClean } from './repository.js';

describe('git repository helpers', () => {
  it('sees a tree as clean right after a commit', async () => {
    const { repo } = await setup();

    expect(await isWorkingTreeClean(repo)).toBe(true);
  });

  it('sees a tree with an untracked file as dirty', async () => {
    const { repo, writeUntrackedFile } = await setup();
    await writeUntrackedFile();

    expect(await isWorkingTreeClean(repo)).toBe(false);
  });

  it('commits every pending change under the message and returns the new commit', async () => {
    const { repo, writeUntrackedFile } = await setup();
    const file = await writeUntrackedFile();
    const message = faker.git.commitMessage();

    const sha = await commitAll(repo, message);

    const git = simpleGit({ baseDir: repo });
    const head = await git.log(['-1']);
    expect(head.latest?.message).toBe(message);
    expect(head.latest?.hash.startsWith(sha ?? 'no commit')).toBe(true);
    expect((await git.raw(['show', '--name-only', '--format='])).trim()).toBe(file);
    expect(await isWorkingTreeClean(repo)).toBe(true);
  });

  it('commits nothing when nothing changed', async () => {
    const { repo } = await setup();
    const before = await simpleGit({ baseDir: repo }).revparse(['HEAD']);

    expect(await commitAll(repo, faker.git.commitMessage())).toBeNull();
    expect(await simpleGit({ baseDir: repo }).revparse(['HEAD'])).toBe(before);
  });

  it('accepts the root of a repository', async () => {
    const { repo } = await setup();

    expect((await ensureRepositoryRoot(repo)).isOk()).toBe(true);
  });

  it('refuses a directory inside a repository, naming its root', async () => {
    const { repo } = await setup();
    const subdirectory = path.join(repo, faker.word.noun());
    await mkdir(subdirectory);

    const refusal = await ensureRepositoryRoot(subdirectory);

    expect(refusal.isErr() && refusal.error).toBeInstanceOf(ConfigInvalid);
    expect(refusal.isErr() && refusal.error.message).toMatch(wholePath(await realpath(repo)));
  });

  it('accepts a directory that is not a repository yet', async () => {
    const directory = await tempDirectory('jig-not-a-repo-');

    expect((await ensureRepositoryRoot(directory)).isOk()).toBe(true);
  });

  async function setup() {
    const { dir } = await createTempRepo();
    const writeUntrackedFile = async () => {
      const file = `${faker.string.uuid()}.txt`;
      await writeFile(path.join(dir, file), faker.lorem.paragraph());
      return file;
    };
    return { repo: dir, writeUntrackedFile };
  }
});

/** Matches the path itself, not merely as the start of a longer path below it. */
function wholePath(directory: string) {
  return new RegExp(`${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!/)`);
}
