import { Result } from 'better-result';

import type { RunId } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import { type GitCommandFailed } from '../../ports/git-failures.js';
import type { RunCode, RunCodeRestoreFailure } from '../../ports/run-code.js';
import { RunCodeUnavailable, RunStateConflict } from '../../ports/run-state-failures.js';
import { RemoteRef } from './remote-ref.js';
import { isAncestor } from './repository.js';
import { exactHead, fastForwardWorktree, hasCommit, worktreeHolding } from './run-history.js';

/** Restores a deferred run's code checkpoint from this clone, or from the branch already published. */
export class GitRunCode implements RunCode {
  private readonly refs: RemoteRef;

  constructor(
    private readonly repoRoot: string,
    private readonly remote = 'origin',
  ) {
    this.refs = new RemoteRef(repoRoot, remote);
  }

  checkpoint(runId: RunId): Promise<Result<string | undefined, GitCommandFailed>> {
    return exactHead(this.repoRoot, branchRef(runId));
  }

  restore(runId: RunId, revision: string): Promise<Result<void, RunCodeRestoreFailure>> {
    return Result.gen(async function* (this: GitRunCode) {
      const local = yield* Result.await(exactHead(this.repoRoot, branchRef(runId)));
      if (local === revision) return Result.ok();
      yield* Result.await(this.ensureAvailable(runId, revision));
      if (!local) return this.moveBranch(runId, revision, '');
      if (yield* Result.await(isAncestor(this.repoRoot, revision, local))) return Result.ok();
      if (yield* Result.await(isAncestor(this.repoRoot, local, revision)))
        return this.moveBranch(runId, revision, local);
      return Result.err(
        new RunStateConflict({
          message: `The run branch "${runBranchFor(runId)}" here has diverged from the saved checkpoint ${revision}.`,
        }),
      );
    }, this);
  }

  private ensureAvailable(
    runId: RunId,
    revision: string,
  ): Promise<Result<void, RunCodeRestoreFailure>> {
    return Result.gen(async function* (this: GitRunCode) {
      if (yield* Result.await(hasCommit(this.repoRoot, revision))) return Result.ok();
      const listed = yield* Result.await(this.refs.list([branchRef(runId)]));
      if (listed.has(branchRef(runId)))
        yield* Result.await(
          this.refs.fetch([
            `+${branchRef(runId)}:refs/remotes/${this.remote}/${runBranchFor(runId)}`,
          ]),
        );
      if (yield* Result.await(hasCommit(this.repoRoot, revision))) return Result.ok();
      return Result.err(
        new RunCodeUnavailable({
          message: `Run ${runId} saved its code at ${revision}, which is neither in this clone nor published on ${this.remote}. Resume it from the clone that ran it, or start a new run.`,
        }),
      );
    }, this);
  }

  /** A branch checked out somewhere moves with its worktree, so its index and files follow it. */
  private moveBranch(
    runId: RunId,
    revision: string,
    expected: string,
  ): Promise<Result<void, GitCommandFailed>> {
    return Result.gen(async function* (this: GitRunCode) {
      const worktree = yield* Result.await(worktreeHolding(this.repoRoot, branchRef(runId)));
      if (worktree) return fastForwardWorktree(worktree, revision);
      const moved = await this.refs.required(['update-ref', branchRef(runId), revision, expected]);
      return moved.map(() => undefined);
    }, this);
  }
}

function branchRef(runId: RunId): string {
  return `refs/heads/${runBranchFor(runId)}`;
}
