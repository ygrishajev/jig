import { isTransient, type JigError } from './errors.js';
import type { RunSettings } from './settings.js';

/**
 * The bounded retries a step or a sandbox start gets. Each caller adds its own `onFailedAttempt`;
 * the shape matches a retry port's policy without domain depending on that port.
 */
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
