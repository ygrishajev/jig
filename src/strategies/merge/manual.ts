import type { MergeStrategy } from './types.js';

export class ManualMergeStrategy implements MergeStrategy {
  async merge(_repoRoot: string, _branchName: string, _baseBranch: string): Promise<void> {
    // Intentionally does nothing: merging into the base branch is left to the
    // operator's own git workflow. finalizeRun still detects a manual merge
    // by checking git state directly, which is what lets `resume` continue.
  }
}
