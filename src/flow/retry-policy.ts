import { type FailureKind, isTransient } from '../domain/errors.js';
import type { RunSettings } from '../domain/settings.js';
import type { RetryPolicy } from '../failures/retry.js';

/** Each caller supplies its own onFailedAttempt, so the shared policy leaves it out. */
export function transientRetryPolicy(settings: RunSettings): RetryPolicy<{ kind: FailureKind }> {
  return {
    retries: settings.maxStepRetries,
    delayMs: settings.retryDelayMs,
    shouldRetry: isTransient,
  };
}
