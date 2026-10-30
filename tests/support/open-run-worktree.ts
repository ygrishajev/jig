import { existsSync } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { runDirectory } from '../../src/adapters/local-store/run-paths.js';
import type { RunId } from '../../src/domain/run-id.js';
import { runBranchFor } from '../../src/domain/run-state.js';

export interface RunWorktreeOptions {
  repoRoot: string;
  runId: RunId;
  baseBranch: string;
}

/**
 * Stands in for sandcastle's worktree in tests: makes sure the run's worktree exists with the
 * run branch checked out, creating the branch from the base branch on first use.
 */
export async function openRunWorktree({ repoRoot, runId, baseBranch }: RunWorktreeOptions) {
  const worktreePath = path.join(runDirectory(repoRoot, runId), 'workspace');
  const branch = runBranchFor(runId);
  const repo = simpleGit({ baseDir: repoRoot });

  if (!existsSync(worktreePath)) {
    await repo.raw(['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
    return worktreePath;
  }
  const worktree = simpleGit({ baseDir: worktreePath });
  if ((await repo.branchLocal()).all.includes(branch)) await worktree.checkout(branch);
  else await worktree.checkoutBranch(branch, baseBranch);
  return worktreePath;
}
