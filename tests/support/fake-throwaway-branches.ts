import { Result } from 'better-result';

import type { ThrowawaySandboxes } from '../../src/app/throwaway-sandbox.js';

/** The local branches throwaway sandboxes come and go on, without a repository. */
export function fakeThrowawayBranches() {
  const branches = new Set<string>();
  const operations: Omit<ThrowawaySandboxes, 'open' | 'log'> = {
    currentBranch: async () => Result.ok('main'),
    discardBranch: async (branch) => {
      branches.delete(branch);
      return Result.ok();
    },
    discardBranchOnExit: (_branch, use) => use(),
  };
  return { branches, operations };
}
