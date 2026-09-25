import type { Slice } from '../../state/types.js';

export interface MergeStrategy {
  merge(repoRoot: string, slice: Slice, baseBranch: string): Promise<void>;
}
