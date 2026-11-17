import type { Result } from 'better-result';
import { setTimeout as sleep } from 'node:timers/promises';

import { isTransient, type JigError } from './errors.js';
import type { RunSettings } from './settings.js';

/**
 * The retry decisions every transient failure in a run shares: how often to try again, how far
 * apart, and which failures are worth another attempt. Each caller adds its own onFailedAttempt.
 */
export type TransientRetryPolicy = Omit<RetryPolicy<JigError>, 'onFailedAttempt'>;

export interface RetryPolicy<E> {
  retries: number;
  delayMs: number;
  shouldRetry(error: E): boolean;
  onFailedAttempt?(failure: { error: E; attempt: number; retriesLeft: number }): void;
}

export async function retryResult<T, E>(
  operation: () => Promise<Result<T, E>>,
  policy: RetryPolicy<E>,
): Promise<Result<T, E>> {
  for (let attempt = 1; ; attempt++) {
    const result = await operation();
    if (result.isOk()) return result;

    const retriesLeft = policy.retries - attempt + 1;
    policy.onFailedAttempt?.({ error: result.error, attempt, retriesLeft });
    if (retriesLeft <= 0 || !policy.shouldRetry(result.error)) return result;

    await sleep(policy.delayMs * 2 ** (attempt - 1));
  }
}

/** One policy for everything that retries a transient failure: a step, or a sandbox that did not start. */
export function transientRetryPolicy(settings: RunSettings): TransientRetryPolicy {
  return {
    retries: settings.maxStepRetries,
    delayMs: settings.retryDelayMs,
    shouldRetry: isTransient,
  };
}
