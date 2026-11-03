import type { Slice } from './slice.js';

/** How many times a step that failed transiently is tried again before the run blocks. */
export const MAX_STEP_RETRIES = 2;

/** Long enough for a rate limit or a container hiccup to clear. */
export const RETRY_DELAY_MS = 5000;

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
