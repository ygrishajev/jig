import type { Result } from 'better-result';
import { setTimeout as sleep } from 'node:timers/promises';

export interface RetryPolicy<E> {
  retries: number;
  delayMs: number;
  shouldRetry(error: E): boolean;
  onFailedAttempt?(failure: { error: E; attempt: number; retriesLeft: number }): void;
}

/**
 * better-result retries only a rejected promise inside `Result.tryPromise`, but jig operations
 * return an `Err` and callers are told about every failed attempt, the last one included.
 */
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
