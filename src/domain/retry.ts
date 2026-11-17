import type { Result } from 'better-result';
import { setTimeout as sleep } from 'node:timers/promises';

import { isTransient, type JigError } from './errors.js';
import type { RunSettings } from './settings.js';

/** Each caller supplies its own onFailedAttempt, so the shared policy leaves it out. */
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

export function transientRetryPolicy(settings: RunSettings): TransientRetryPolicy {
  return {
    retries: settings.maxStepRetries,
    delayMs: settings.retryDelayMs,
    shouldRetry: isTransient,
  };
}
