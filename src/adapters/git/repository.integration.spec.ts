import { faker } from '@faker-js/faker';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { GitCommandFailed, RepositoryInvalid } from '../../ports/git-failures.js';
import { ensureRepositoryRoot, isAncestor, isWorkingTreeClean, openRepo } from './repository.js';

describe('git repository helpers', () => {
  it('distinguishes ancestors from non-ancestors', async () => {
    const { repo } = await setup();
    const git = openRepo(repo);
    const parent = await git.revparse(['HEAD']);
    await git.commit(faker.git.commitMessage(), ['--allow-empty']);
    const child = await git.revparse(['HEAD']);

    expect((await isAncestor(repo, parent, child)).unwrap()).toBe(true);
    expect((await isAncestor(repo, child, parent)).unwrap()).toBe(false);
  });

  it('reports unknown commits as command failures', async () => {
    const { repo } = await setup();
    const unknown = faker.git.commitSha();
    const result = await isAncestor(repo, unknown, 'HEAD');

    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toBeInstanceOf(GitCommandFailed);
    expect(result.isErr() && result.error.command).toBe(
      `git merge-base --is-ancestor ${unknown} HEAD`,
    );
    expect(result.isErr() && result.error.output).toContain(unknown);
  });

  it('reports an execution that cannot start as a command failure', async () => {
    const { repo } = await setup();
    const result = await isAncestor(path.join(repo, faker.string.uuid()), 'HEAD', 'HEAD');

    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toBeInstanceOf(GitCommandFailed);
  });

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

    expect(refusal.isErr() && refusal.error).toBeInstanceOf(RepositoryInvalid);
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
