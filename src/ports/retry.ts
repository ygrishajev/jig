import type { Result } from 'better-result';

/**
 * Runs `operation` again while it returns an `Err` the policy accepts, waiting longer before each
 * attempt, and returns the first success or the last failure. A throw is a bug and goes through.
 */
export type RetryResult = <T, E>(
  operation: () => Promise<Result<T, E>>,
  policy: RetryPolicy<E>,
) => Promise<Result<T, E>>;

/** How many more attempts an operation gets, how long to wait first, and which failures earn one. */
export interface RetryPolicy<E> {
  retries: number;
  delayMs: number;
  shouldRetry(error: E): boolean;
  onFailedAttempt?(failure: { error: E; attempt: number; retriesLeft: number }): void;
}
