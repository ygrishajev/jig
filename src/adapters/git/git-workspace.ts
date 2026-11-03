import { Result } from 'better-result';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { type GitCommandFailed, MergeFailed, type RemoteUnavailable } from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import type { CommitSummary } from '../../domain/usage.js';
import { isBranchMergedInto, mergeBranchInto } from '../../git/merge.js';
import { commitAll, gitCommand, openRepo } from '../../git/repository.js';
import type { Workspace } from '../../ports/workspace.js';

export interface GitWorkspaceOptions {
  repoRoot: string;
  worktreePath: string;
  runId: RunId;
  baseBranch: string;
}

export class GitWorkspace implements Workspace {
  private readonly runBranch: string;

  constructor(private readonly options: GitWorkspaceOptions) {
    this.runBranch = runBranchFor(options.runId);
  }

  async commitAll(message: string): Promise<Result<void, GitCommandFailed>> {
    const committed = await commitAll(this.options.worktreePath, message);
    return committed.map(() => undefined);
  }

  headCommit(): Promise<Result<string, GitCommandFailed>> {
    return gitCommand('rev-parse', () => openRepo(this.options.worktreePath).revparse(['HEAD']));
  }

  forkPoint(): Promise<Result<string, GitCommandFailed>> {
    return gitCommand('merge-base', async () => {
      const forkPoint = await openRepo(this.options.worktreePath).raw([
        'merge-base',
        this.options.baseBranch,
        'HEAD',
      ]);
      return forkPoint.trim();
    });
  }

  summariseCommitsSince(since: string): Promise<Result<CommitSummary, GitCommandFailed>> {
    return Result.gen(async function* (this: GitWorkspace) {
      const sha = yield* Result.await(this.headCommit());
      const diff = yield* Result.await(
        gitCommand('diff', () => openRepo(this.options.worktreePath).diffSummary([since, sha])),
      );
      return Result.ok({
        sha,
        filesChanged: diff.changed,
        insertions: diff.insertions,
        deletions: diff.deletions,
      });
    }, this);
  }

  async readRepoFile(relativePath: string): Promise<string | undefined> {
    try {
      return await readFile(path.join(this.options.repoRoot, relativePath), 'utf-8');
    } catch {
      return undefined;
    }
  }

  async mergeRunBranch(): Promise<Result<void, MergeFailed>> {
    const { repoRoot, baseBranch } = this.options;
    const merged = await mergeBranchInto(repoRoot, this.runBranch, baseBranch);
    if (merged.isOk()) return Result.ok();
    await abortMergeInProgress(repoRoot);
    return Result.err(
      new MergeFailed({
        message: `Merging "${this.runBranch}" into "${baseBranch}" failed: ${merged.error.message}`,
      }),
    );
  }

  isRunBranchMerged(): Promise<Result<boolean, GitCommandFailed | RemoteUnavailable>> {
    return isBranchMergedInto(this.options.repoRoot, this.runBranch, this.options.baseBranch);
  }
}

/** Leaves the operator's repository as it was; there is nothing to abort when git never started merging. */
async function abortMergeInProgress(repoRoot: string): Promise<void> {
  await openRepo(repoRoot)
    .raw(['merge', '--abort'])
    .catch(() => undefined);
}
