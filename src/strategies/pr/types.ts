import type { RunPaths } from '../../state/run-paths.js';

export interface PrCreateStrategy {
  create(paths: RunPaths): Promise<void>;
}
