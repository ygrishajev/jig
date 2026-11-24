import { Result } from 'better-result';

import type { WarningLog } from '../ports/observability.js';
import { reportCleanup } from './report-cleanup.js';

/** How a resource is acquired and released; `withResource` owns when. */
export interface Lifetime<R, AcquireFailure, ReleaseFailure> {
  acquire(): Promise<Result<R, AcquireFailure>>;
  release(resource: R): Promise<Result<void, ReleaseFailure>>;
}

/**
 * Acquires the resource, hands it to `use` and releases it however `use` ends. A failed release
 * replaces a success and is logged after a failure. A panic in `use` still releases the resource
 * and then propagates as it was thrown, with a failed release logged.
 */
export async function withResource<R, AcquireFailure, ReleaseFailure, T, E>(
  lifetime: Lifetime<R, AcquireFailure, ReleaseFailure>,
  log: WarningLog,
  use: (resource: R) => Promise<Result<T, E>>,
): Promise<Result<T, AcquireFailure | E | ReleaseFailure>> {
  const acquired = await lifetime.acquire();
  if (acquired.isErr()) return Result.err(acquired.error);
  let used: Result<T, E>;
  let released: Result<void, ReleaseFailure>;
  let useReturned = false;
  try {
    used = await use(acquired.value);
    useReturned = true;
  } finally {
    released = await lifetime.release(acquired.value);
    if (!useReturned && released.isErr()) {
      log.warn({ err: released.error }, 'cleanup failed after the work panicked');
    }
  }
  return reportCleanup(used, released, log);
}

/**
 * Attempts every release in order, even after one fails or panics, and returns the first
 * failure; each later failure is logged.
 */
export async function releaseInOrder<ReleaseFailure>(
  releases: readonly (() => Promise<Result<void, ReleaseFailure>>)[],
  log: WarningLog,
): Promise<Result<void, ReleaseFailure>> {
  const [release, ...later] = releases;
  if (!release) return Result.ok();
  let released: Result<void, ReleaseFailure>;
  let laterReleased: Result<void, ReleaseFailure>;
  try {
    released = await release();
  } finally {
    laterReleased = await releaseInOrder(later, log);
  }
  if (released.isOk()) return laterReleased;
  if (laterReleased.isErr()) {
    log.warn({ err: laterReleased.error }, 'a further cleanup failed as well');
  }
  return released;
}
