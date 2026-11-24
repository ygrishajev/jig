import type { Result } from 'better-result';

import type { GitCommandFailed, RepositoryInvalid } from '../../ports/git-failures.js';
import { getCurrentBranch } from './branch.js';
import { discardBranch, discardBranchOnExit } from './throwaway-branch.js';

/** The branch a throwaway sandbox starts from, and how its own branch is removed, in `repoRoot`. */
export function throwawayBranches(repoRoot: string): {
  currentBranch(): Promise<Result<string, RepositoryInvalid | GitCommandFailed>>;
  discardBranch(branch: string): Promise<Result<void, GitCommandFailed>>;
  discardBranchOnExit<T>(branch: string, use: () => Promise<T>): Promise<T>;
} {
  return {
    currentBranch: () => getCurrentBranch(repoRoot),
    discardBranch: (branch) => discardBranch(repoRoot, branch),
    discardBranchOnExit: (branch, use) => discardBranchOnExit(repoRoot, branch, use),
  };
}
