import { isBranchMergedInto } from '../git/merge.js';
import { openRepo } from '../git/repository.js';
import { logRun } from '../logging.js';
import { runBranchFor } from '../state/types.js';
import type { RunPaths } from '../state/run-paths.js';
import type { MergeStrategy } from '../strategies/merge/types.js';

export interface FinalizeRunInput {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
  mergeStrategy: MergeStrategy;
}

export interface FinalizeRunResult {
  blocked: boolean;
  reason?: string;
  complete: boolean;
}

/**
 * The run's single feature branch — every slice's commits land here — is
 * merged into baseBranch exactly once, after every slice has been approved.
 * This is the only git-merge action the whole run performs.
 */
export async function finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult> {
  const { repoRoot, paths, baseBranch, mergeStrategy } = input;
  const branch = runBranchFor(paths.runId);
  if (await isBranchMergedInto(repoRoot, branch, baseBranch)) {
    return { blocked: false, complete: true };
  }
  try {
    await mergeStrategy.merge(repoRoot, branch, baseBranch);
    if (await isBranchMergedInto(repoRoot, branch, baseBranch)) {
      logRun(paths.runId, `run branch "${branch}" merged into "${baseBranch}"`);
      return { blocked: false, complete: true };
    }
    return {
      blocked: true,
      reason: `run branch "${branch}" is not yet merged into "${baseBranch}"`,
      complete: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await openRepo(repoRoot).raw(['merge', '--abort']);
    } catch {
      // Best-effort cleanup — if there was no merge in progress to abort
      // (e.g. the failure happened before git started merging), this
      // throws too; the real error is already captured in `message`.
    }
    return {
      blocked: true,
      reason: `merge failed for run branch "${branch}": ${message}`,
      complete: false,
    };
  }
}
