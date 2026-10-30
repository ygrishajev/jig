import { faker } from '@faker-js/faker';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { createRunWorktree } from '../../../tests/support/run-worktree.js';
import { MergeFailed } from '../../domain/errors.js';
import { isWorkingTreeClean } from '../../git/repository.js';

describe('GitWorkspace', () => {
  it("measures the run branch's commits since a point, by files and lines", async () => {
    const { workspace, writeInWorktree } = await setup();
    const since = await workspace.forkPoint();
    await writeInWorktree('one.txt', 'a\nb\nc\n');
    await writeInWorktree('two.txt', 'd\n');
    await workspace.commitAll(faker.git.commitMessage());

    const summary = await workspace.summariseCommitsSince(since);

    expect(summary).toEqual({
      sha: await workspace.headCommit(),
      filesChanged: 2,
      insertions: 4,
      deletions: 0,
    });
  });

  it('commits nothing when the worktree has no changes', async () => {
    const { workspace } = await setup();
    const head = await workspace.headCommit();

    await workspace.commitAll(faker.git.commitMessage());

    expect(await workspace.headCommit()).toBe(head);
    expect(await workspace.forkPoint()).toBe(head);
  });

  it("reads a file from the operator's repository, and nothing for one that is not there", async () => {
    const { workspace, repo } = await setup();
    const contents = faker.lorem.paragraph();
    await writeFile(path.join(repo, 'NOTES.md'), contents);

    expect(await workspace.readRepoFile('NOTES.md')).toBe(contents);
    expect(await workspace.readRepoFile(`${faker.string.uuid()}.md`)).toBeUndefined();
  });

  it("leaves the operator's repository as it was when the merge conflicts", async () => {
    const { workspace, repo, git, writeInWorktree } = await setup();
    await writeInWorktree('README.md', faker.lorem.paragraph());
    await workspace.commitAll(faker.git.commitMessage());
    await writeFile(path.join(repo, 'README.md'), faker.lorem.paragraph());
    await git.add('README.md').commit(faker.git.commitMessage());

    await expect(workspace.mergeRunBranch()).rejects.toBeInstanceOf(MergeFailed);

    expect(existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(await isWorkingTreeClean(repo)).toBe(true);
    expect(await workspace.isRunBranchMerged()).toBe(false);
  });

  async function setup() {
    const created = await createRunWorktree(runId());
    const writeInWorktree = (file: string, contents: string) =>
      writeFile(path.join(created.worktreePath, file), contents);
    return {
      workspace: created.workspace,
      repo: created.repo.dir,
      git: created.git,
      writeInWorktree,
    };
  }
});
