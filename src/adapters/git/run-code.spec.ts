import { faker } from '@faker-js/faker';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
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

  async function setup() {
    const { cloneOf } = await createRemote();
    const here = await cloneOf();
    const id = runId();
    const branch = runBranchFor(id);
    const commitOnRunBranch = async (repo: string) => {
      const git = simpleGit(repo);
      const current = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      const exists = (await git.branchLocal()).all.includes(branch);
      await git.checkout(exists ? [branch] : ['-b', branch]);
      await writeFile(path.join(repo, `${faker.string.alpha(10)}.txt`), faker.lorem.paragraph());
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
    return { here, id, cloneOf, commitOnRunBranch, branchHead };
  }
});
