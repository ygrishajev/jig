import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { execa } from 'execa';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it, onTestFinished } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { FakeAgentSession } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { throwawayBranches } from '../adapters/git/throwaway-branches.js';
import { runBranchFor, type RunIdentity } from '../domain/run-state.js';
import { SandboxUnavailable, SetupCommandFailed } from '../ports/agent-session.js';
import type { WarningLog } from '../ports/observability.js';
import { type ThrowawaySandboxes, withThrowawaySandbox } from './throwaway-sandbox.js';

describe('withThrowawaySandbox on real git', () => {
  it('removes the worktree the close preserved for uncommitted changes, with its branch', async () => {
    const { sandboxes, repoRoot, worktreeOf, branchOf, worktreeSession } = await setup({
      withWorktree: true,
    });

    const result = await withThrowawaySandbox(sandboxes, null, async (session) => {
      await writeFile(
        path.join(session.worktreePath, faker.system.fileName()),
        faker.lorem.paragraph(),
      );
      return Result.ok(session.worktreePath);
    });

    expect(unwrap(result)).toBe(worktreeOf());
    expect(worktreeSession().preservedWorktreePath).toBe(worktreeOf());
    expect((await simpleGit({ baseDir: repoRoot }).branchLocal()).all).not.toContain(branchOf());
    expect(
      await simpleGit({ baseDir: repoRoot }).raw(['worktree', 'list', '--porcelain']),
    ).not.toContain(worktreeOf());
  });

  async function setup(
    input: {
      failWith?: SetupCommandFailed;
      withWorktree?: boolean;
      outsideRepository?: string;
    } = {},
  ) {
    const { dir: repoRoot } = await createTempRepo();
    const session = new FakeAgentSession(repoRoot);
    const branches: string[] = [];
    const worktrees: string[] = [];
    const worktreeSessions: HostWorktreeSession[] = [];
    let opened = 0;
    const open = async ({ runId }: RunIdentity) => {
      opened++;
      if (input.failWith) return Result.err(input.failWith);
      const branch = runBranchFor(runId);
      if (input.withWorktree) {
        const worktree = path.join(
          await tempDirectory('jig-worktree-'),
          branch.replaceAll('/', '-'),
        );
        await simpleGit({ baseDir: repoRoot }).raw(['worktree', 'add', '-b', branch, worktree]);
        worktrees.push(worktree);
        branches.push(branch);
        const worktreeSession = new HostWorktreeSession(repoRoot, worktree);
        worktreeSessions.push(worktreeSession);
        return Result.ok(worktreeSession);
      }
      await simpleGit({ baseDir: repoRoot }).branch([branch]);
      branches.push(branch);
      return Result.ok(session);
    };
    const sandboxes: ThrowawaySandboxes = {
      ...throwawayBranches(input.outsideRepository ?? repoRoot),
      log: mock<WarningLog>(),
      open,
    };
    onTestFinished(async () => {
      const git = simpleGit({ baseDir: repoRoot });
      for (const worktree of worktrees) {
        await git.raw(['worktree', 'remove', '--force', worktree]).catch(() => undefined);
      }
    });
    return {
      sandboxes,
      session,
      branches,
      repoRoot,
      opened: () => opened,
      worktreeOf: () => worktrees[0],
      branchOf: () => branches[0],
      worktreeSession: () => worktreeSessions[0],
    };
  }
});

/**
 * Plays sandcastle 0.14.0's close contract (`createSandbox.doClose`): the container stops, a
 * worktree with uncommitted changes is preserved, a clean one is removed, and a removal that
 * fails is tolerated.
 */
class HostWorktreeSession extends FakeAgentSession {
  /** The worktree a close preserved instead of removing, the outcome sandcastle reports back. */
  preservedWorktreePath?: string;

  constructor(
    private readonly hostRepoRoot: string,
    worktreePath: string,
  ) {
    super(worktreePath);
  }

  override async close(): Promise<Result<void, SandboxUnavailable>> {
    if (this.failCloseWith) return super.close();
    if (this.closed) return Result.ok();
    this.closed = true;
    if (await this.hasUncommittedChanges()) {
      this.preservedWorktreePath = this.worktreePath;
      return Result.ok();
    }
    await execa('git', ['worktree', 'remove', '--force', this.worktreePath], {
      cwd: this.hostRepoRoot,
      reject: false,
    });
    return Result.ok();
  }

  private async hasUncommittedChanges(): Promise<boolean> {
    const status = await execa('git', ['status', '--porcelain'], {
      cwd: this.worktreePath,
      reject: false,
    });
    return status.stdout.trim().length > 0;
  }
}
