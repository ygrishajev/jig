import { mergeBranchInto } from '../../git/merge.js';
import type { Slice } from '../../state/types.js';
import type { MergeStrategy } from './types.js';

export class AutoMergeStrategy implements MergeStrategy {
  async merge(repoRoot: string, slice: Slice, baseBranch: string): Promise<void> {
    await mergeBranchInto(repoRoot, slice.branch, baseBranch);
  }
}
