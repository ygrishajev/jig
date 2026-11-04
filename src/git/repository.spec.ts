import { faker } from '@faker-js/faker';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { ConfigInvalid } from '../domain/errors.js';
import { ensureRepositoryRoot, isWorkingTreeClean } from './repository.js';

describe('git repository helpers', () => {
  it('sees a tree as clean right after a commit', async () => {
    const { repo } = await setup();

    expect((await isWorkingTreeClean(repo)).unwrap()).toBe(true);
  });

  it('sees a tree with an untracked file as dirty', async () => {
    const { repo, writeUntrackedFile } = await setup();
    await writeUntrackedFile();

    expect((await isWorkingTreeClean(repo)).unwrap()).toBe(false);
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
