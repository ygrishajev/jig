import { mergeBranchInto } from '../../git/merge.js';
import type { MergeStrategy } from './types.js';

export class AutoMergeStrategy implements MergeStrategy {
  async merge(repoRoot: string, branchName: string, baseBranch: string): Promise<void> {
    await mergeBranchInto(repoRoot, branchName, baseBranch);
  }
}
