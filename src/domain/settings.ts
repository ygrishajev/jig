import type { Slice } from './slice.js';

/** The parts of configuration that decide how a run moves, as opposed to how it is wired. */
export interface RunSettings {
  reviewCycleCap: number;
  maxStepRetries: number;
  /** Delay before the first retry of a failed step; later retries back off exponentially. */
  retryDelayMs: number;
  designGate: 'auto' | 'checkpoint';
  mergeMode: 'auto' | 'manual';
  verifyCommand?: string;
}

export function reviewCapReached(slice: Slice, settings: RunSettings) {
  return slice.reviewCycles >= settings.reviewCycleCap;
}
