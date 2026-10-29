import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MergeFailed } from '../../domain/errors.js';
import { runBranchFor } from '../../domain/run-state.js';
import type { Workspace } from '../../ports/workspace.js';
import { isBranchMergedInto, mergeBranchInto } from '../../git/merge.js';
import { commitAll, openRepo } from '../../git/repository.js';

export interface GitWorkspaceOptions {
  repoRoot: string;
  worktreePath: string;
  runId: string;
  baseBranch: string;
}

export class GitWorkspace implements Workspace {
  private readonly runBranch: string;

  constructor(private readonly options: GitWorkspaceOptions) {
    this.runBranch = runBranchFor(options.runId);
  }

  async commitAll(message: string) {
    const sha = await commitAll(this.options.worktreePath, message);
    if (!sha) return null;
    const diff = await openRepo(this.options.worktreePath).diffSummary([`${sha}^!`]);
    return {
      sha,
      filesChanged: diff.changed,
      insertions: diff.insertions,
      deletions: diff.deletions,
    };
  }

  headCommit() {
    return openRepo(this.options.worktreePath).revparse(['HEAD']);
  }

  async readRepoFile(relativePath: string) {
    try {
      return await readFile(path.join(this.options.repoRoot, relativePath), 'utf-8');
    } catch {
      return undefined;
    }
  }

  async mergeRunBranch() {
    const { repoRoot, baseBranch } = this.options;
    try {
      await mergeBranchInto(repoRoot, this.runBranch, baseBranch);
    } catch (error) {
      await abortMergeInProgress(repoRoot);
      const reason = error instanceof Error ? error.message : String(error);
      throw new MergeFailed(`Merging "${this.runBranch}" into "${baseBranch}" failed: ${reason}`);
    }
  }

  isRunBranchMerged() {
    return isBranchMergedInto(this.options.repoRoot, this.runBranch, this.options.baseBranch);
  }
}

/** Leaves the operator's repository as it was; there is nothing to abort when git never started merging. */
async function abortMergeInProgress(repoRoot: string) {
  await openRepo(repoRoot)
    .raw(['merge', '--abort'])
    .catch(() => undefined);
}
