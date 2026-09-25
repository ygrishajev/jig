import type { RunPaths } from '../../state/run-paths.js';
import type { Slice } from '../../state/types.js';

export interface PrCreateStrategy {
  create(paths: RunPaths, slice: Slice): Promise<void>;
}
