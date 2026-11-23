import { setTimeout as sleep } from 'node:timers/promises';

import type { RetryResult } from '../ports/retry.js';

/**
 * better-result retries only a `Result.tryPromise` whose `try` throws; an operation that already
 * returns its failure as an `Err` would have to be turned back into a rejection to use it.
 */
export const retryResult: RetryResult = async (operation, policy) => {
  for (let attempt = 1; ; attempt++) {
    const result = await operation();
    if (result.isOk()) return result;

    const retriesLeft = policy.retries - attempt + 1;
    policy.onFailedAttempt?.({ error: result.error, attempt, retriesLeft });
    if (retriesLeft <= 0 || !policy.shouldRetry(result.error)) return result;

    await sleep(policy.delayMs * 2 ** (attempt - 1));
  }
};
