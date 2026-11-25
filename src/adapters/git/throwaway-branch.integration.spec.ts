import { faker } from '@faker-js/faker';
import { EventEmitter } from 'node:events';
import { constants } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it, vi } from 'vitest';

import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { discardBranchOnExit, type ExitingProcess } from './throwaway-branch.js';

describe('discardBranchOnExit', () => {
  it('removes the branch and its worktree when the process exits before the work finishes', async () => {
    const { repo, branch, host, git } = await setup();
    const worktree = path.join(await tempDirectory(), branch);

    await discardBranchOnExit(
      repo,
      branch,
      async () => {
        await git.raw(['worktree', 'add', '-b', branch, worktree]);
        host.emit('exit', 1);
      },
      host,
    );

    expect((await git.branchLocal()).all).not.toContain(branch);
    expect(await git.raw(['worktree', 'list', '--porcelain'])).not.toContain(worktree);
  });

  it('leaves the branch to the caller once the work finishes', async () => {
    const { repo, branch, host, git } = await setup();
    const value = faker.string.alphanumeric(8);

    const returned = await discardBranchOnExit(
      repo,
      branch,
      async () => {
        await git.branch([branch]);
        return value;
      },
      host,
    );
    host.emit('exit', 0);

    expect(returned).toBe(value);
    expect((await git.branchLocal()).all).toContain(branch);
  });

  it('exits on Ctrl+C, so the exit cleanup runs', async () => {
    const { repo, branch, host } = await setup();

    await discardBranchOnExit(repo, branch, async () => void host.emit('SIGINT', 'SIGINT'), host);

    expect(host.exit).toHaveBeenCalledWith(128 + constants.signals.SIGINT);
  });

  async function setup() {
    const { dir } = await createTempRepo();
    const host = Object.assign(new EventEmitter(), { exit: vi.fn<ExitingProcess['exit']>() });
    const branch = `jig/run/init-${faker.string.alphanumeric({ length: 6, casing: 'lower' })}`;
    return { repo: dir, branch, host, git: simpleGit({ baseDir: dir }) };
  }
});
