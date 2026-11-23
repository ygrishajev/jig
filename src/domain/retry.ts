import { isTransient, type JigError } from './errors.js';
import type { RunSettings } from './settings.js';

/** Each caller supplies its own onFailedAttempt, so the shared policy leaves it out. */
export interface TransientRetryPolicy {
  retries: number;
  delayMs: number;
  shouldRetry(error: JigError): boolean;
}

export function transientRetryPolicy(settings: RunSettings): TransientRetryPolicy {
  return {
    retries: settings.maxStepRetries,
    delayMs: settings.retryDelayMs,
    shouldRetry: isTransient,
  };
}
