import { faker } from '@faker-js/faker';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { runBranchFor } from '../../domain/run-state.js';
import { GitRunCode } from './run-code.js';

describe('GitRunCode', () => {
  it('checkpoints the commit the run branch holds, and nothing before it has one', async () => {
    const { here, id, commitOnRunBranch } = await setup();
    const code = new GitRunCode(here);
    expect(unwrap(await code.checkpoint(id))).toBeUndefined();

    const head = await commitOnRunBranch(here);

    expect(unwrap(await code.checkpoint(id))).toBe(head);
  });

  it('restores a lost run branch from objects this clone kept', async () => {
    const { here, id, commitOnRunBranch, branchHead } = await setup();
    const checkpoint = await commitOnRunBranch(here);
    await simpleGit(here).branch(['-D', runBranchFor(id)]);

    unwrap(await new GitRunCode(here).restore(id, checkpoint));

    expect(await branchHead(here)).toBe(checkpoint);
  });

  it('restores a checkpoint already published on the remote in another clone', async () => {
    const { here, id, commitOnRunBranch, branchHead, cloneOf } = await setup();
    const checkpoint = await commitOnRunBranch(here);
    await simpleGit(here).push(['origin', runBranchFor(id)]);
    const elsewhere = await cloneOf();

    unwrap(await new GitRunCode(elsewhere).restore(id, checkpoint));

    expect(await branchHead(elsewhere)).toBe(checkpoint);
  });

  it('refuses a checkpoint neither kept here nor published', async () => {
    const { here, id, commitOnRunBranch, branchHead, cloneOf } = await setup();
    const checkpoint = await commitOnRunBranch(here);
    const elsewhere = await cloneOf();

    const restored = await new GitRunCode(elsewhere).restore(id, checkpoint);

    expect(restored.isErr() && restored.error._tag).toBe('RunCodeUnavailable');
    expect(await branchHead(elsewhere)).toBeUndefined();
  });

  it('keeps work committed past the checkpoint and catches a branch behind it up', async () => {
    const { here, id, commitOnRunBranch, branchHead } = await setup();
    const behind = await commitOnRunBranch(here);
    const checkpoint = await commitOnRunBranch(here);
    const ahead = await commitOnRunBranch(here);
    const code = new GitRunCode(here);

    unwrap(await code.restore(id, checkpoint));
    expect(await branchHead(here)).toBe(ahead);

    await simpleGit(here).raw(['update-ref', `refs/heads/${runBranchFor(id)}`, behind]);
    unwrap(await code.restore(id, checkpoint));
    expect(await branchHead(here)).toBe(checkpoint);
  });

  it('refuses a run branch that diverged from the checkpoint, leaving it where it was', async () => {
    const { here, id, commitOnRunBranch, branchHead } = await setup();
    const fork = await commitOnRunBranch(here);
    const checkpoint = await commitOnRunBranch(here);
    await simpleGit(here).raw(['update-ref', `refs/heads/${runBranchFor(id)}`, fork]);
    const diverged = await commitOnRunBranch(here);

    const restored = await new GitRunCode(here).restore(id, checkpoint);

    expect(restored.isErr() && restored.error._tag).toBe('RunStateConflict');
    expect(await branchHead(here)).toBe(diverged);
  });

  it('moves a run branch checked out in a worktree along with its files, keeping uncommitted work', async () => {
    const { here, id, commitOnRunBranch, branchHead, checkOutInWorktree } = await setup();
    const behind = await commitOnRunBranch(here);
    const added = `${faker.string.alpha(10)}.txt`;
    const checkpoint = await commitOnRunBranch(here, added);
    const worktree = await checkOutInWorktree(behind);
    const edited = faker.lorem.paragraph();
    const untracked = `${faker.string.alpha(12)}.txt`;
    await writeFile(path.join(worktree, 'README.md'), edited);
    await writeFile(path.join(worktree, untracked), faker.lorem.paragraph());

    unwrap(await new GitRunCode(here).restore(id, checkpoint));

    const status = await simpleGit(worktree).status();
    expect(await branchHead(here)).toBe(checkpoint);
    expect(await simpleGit(worktree).revparse(['HEAD'])).toBe(checkpoint);
    expect(status.staged).toEqual([]);
    expect(status.modified).toEqual(['README.md']);
    expect(status.not_added).toEqual([untracked]);
    expect(await readFile(path.join(worktree, 'README.md'), 'utf8')).toBe(edited);
    expect(await simpleGit(worktree).raw(['ls-files', '--', added])).toBe(`${added}\n`);
  });

  it('refuses to move a checked-out run branch over uncommitted work, leaving both as they were', async () => {
    const { here, id, commitOnRunBranch, branchHead, checkOutInWorktree } = await setup();
    const behind = await commitOnRunBranch(here);
    const added = `${faker.string.alpha(10)}.txt`;
    const checkpoint = await commitOnRunBranch(here, added);
    const worktree = await checkOutInWorktree(behind);
    const uncommitted = faker.lorem.paragraph();
    await writeFile(path.join(worktree, added), uncommitted);

    const restored = await new GitRunCode(here).restore(id, checkpoint);

    expect(restored.isErr() && restored.error._tag).toBe('GitCommandFailed');
    expect(await branchHead(here)).toBe(behind);
    expect(await readFile(path.join(worktree, added), 'utf8')).toBe(uncommitted);
  });

  async function setup() {
    const { cloneOf } = await createRemote();
    const here = await cloneOf();
    const id = runId();
    const branch = runBranchFor(id);
    const commitOnRunBranch = async (repo: string, file = `${faker.string.alpha(10)}.txt`) => {
      const git = simpleGit(repo);
      const current = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      const exists = (await git.branchLocal()).all.includes(branch);
      await git.checkout(exists ? [branch] : ['-b', branch]);
      await writeFile(path.join(repo, file), faker.lorem.paragraph());
      await git.add('.');
      await git.commit(faker.git.commitMessage());
      const head = await git.revparse(['HEAD']);
      await git.checkout(current);
      return head;
    };
    const branchHead = async (repo: string) => {
      const listed = await simpleGit(repo).raw([
        'for-each-ref',
        '--format=%(objectname)',
        `refs/heads/${branch}`,
      ]);
      return listed.trim() || undefined;
    };
    const checkOutInWorktree = async (revision: string) => {
      const worktree = await tempDirectory('jig-worktree-');
      await simpleGit(here).raw(['update-ref', `refs/heads/${branch}`, revision]);
      await simpleGit(here).raw(['worktree', 'add', worktree, branch]);
      return worktree;
    };
    return { here, id, cloneOf, commitOnRunBranch, branchHead, checkOutInWorktree };
  }
});
