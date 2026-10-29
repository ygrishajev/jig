import { runBranchFor } from '../../src/domain/run-state.js';
import {
  checkoutExistingBranch,
  checkoutNewBranchAt,
  localBranchExists,
} from '../../src/git/branch.js';
import { addWorktreeForNewBranch, worktreeExists } from '../../src/git/worktree.js';
import { worktreeDirectory } from '../../src/adapters/local-store/run-paths.js';

export interface RunWorktreeOptions {
  repoRoot: string;
  runId: string;
  baseBranch: string;
  /** For repositories that sign commits through an agent the sandbox cannot reach. */
  skipCommitSigning: boolean;
}

/**
 * Stands in for sandcastle's worktree in tests: makes sure the run's worktree exists with the
 * run branch checked out, creating the branch from the base branch on first use.
 */
export async function openRunWorktree(options: RunWorktreeOptions) {
  const { repoRoot, runId, baseBranch, skipCommitSigning } = options;
  const worktreePath = worktreeDirectory(repoRoot, runId);
  const branch = runBranchFor(runId);

  if (!(await worktreeExists(repoRoot, worktreePath))) {
    await addWorktreeForNewBranch(repoRoot, worktreePath, branch, baseBranch, {
      skipCommitSigning,
    });
  } else if (await localBranchExists(repoRoot, branch)) {
    await checkoutExistingBranch(worktreePath, branch);
  } else {
    await checkoutNewBranchAt(worktreePath, branch, baseBranch);
  }
  return worktreePath;
}
