import type { Slice } from './slice.js';

/** The parts of configuration that decide how a run moves, as opposed to how it is wired. */
export interface RunSettings {
  reviewCycleCap: number;
  maxStepRetries: number;
  designGate: 'auto' | 'checkpoint';
  mergeMode: 'auto' | 'manual';
  verifyCommand?: string;
}

export function reviewCapReached(slice: Slice, settings: RunSettings) {
  return slice.reviewCycles >= settings.reviewCycleCap;
}
