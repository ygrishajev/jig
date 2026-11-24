import { Result } from 'better-result';

import type { WarningLog } from '../ports/observability.js';
import { reportCleanup } from './report-cleanup.js';

/** How a resource is acquired and released; `withResource` owns when. */
export interface Lifetime<R, AcquireFailure, ReleaseFailure> {
  acquire(): Promise<Result<R, AcquireFailure>>;
  release(resource: R): Promise<Result<void, ReleaseFailure>>;
}

/** One step of releasing what was acquired. */
export type Release<ReleaseFailure> = () => Promise<Result<void, ReleaseFailure>>;

/**
 * Acquires the resource, hands it to `use` and releases it however `use` ends. A failed release
 * replaces a success and is logged after a failure. A panic in `use` still releases the resource
 * and then propagates as it was thrown, with a failed or panicking release logged.
 */
export async function withResource<R, AcquireFailure, ReleaseFailure, T, E>(
  lifetime: Lifetime<R, AcquireFailure, ReleaseFailure>,
  log: WarningLog,
  use: (resource: R) => Promise<Result<T, E>>,
): Promise<Result<T, AcquireFailure | E | ReleaseFailure>> {
  const acquired = await lifetime.acquire();
  if (acquired.isErr()) return Result.err(acquired.error);
  const release: Release<ReleaseFailure> = () => lifetime.release(acquired.value);
  const used = await releasingOnPanic(() => use(acquired.value), [release], log);
  return reportCleanup(used, await release(), log);
}

/**
 * Runs `work`; when it panics, attempts every release before the panic propagates as it was
 * thrown. Use it while acquiring, so a panic cannot leave behind what was acquired so far.
 */
export async function releasingOnPanic<T, ReleaseFailure>(
  work: () => Promise<T>,
  releases: readonly Release<ReleaseFailure>[],
  log: WarningLog,
): Promise<T> {
  let returned = false;
  try {
    const value = await work();
    returned = true;
    return value;
  } finally {
    if (!returned) await releaseAfterPanic(releases, log);
  }
}

/**
 * The panic already propagating is the one reported, so nothing here may throw over it: each
 * release that fails or panics as well is logged instead.
 */
async function releaseAfterPanic<ReleaseFailure>(
  releases: readonly Release<ReleaseFailure>[],
  log: WarningLog,
): Promise<void> {
  for (const release of releases) {
    try {
      const released = await release();
      if (released.isErr()) log.warn({ err: released.error }, 'cleanup failed after a panic');
    } catch (cleanupPanic) {
      log.warn({ err: cleanupPanic }, 'cleanup panicked after an earlier panic');
    }
  }
}

/**
 * Attempts every release in order, even after one fails or panics. The first panic propagates as
 * it was thrown; otherwise the first failure is returned. Every other failure or panic is logged.
 */
export async function releaseInOrder<ReleaseFailure>(
  releases: readonly Release<ReleaseFailure>[],
  log: WarningLog,
): Promise<Result<void, ReleaseFailure>> {
  let firstFailure: Result<void, ReleaseFailure> = Result.ok();
  for (const [index, release] of releases.entries()) {
    const failedSoFar = firstFailure;
    const reportFailedSoFar: Release<ReleaseFailure> = async () => failedSoFar;
    const released = await releasingOnPanic(
      release,
      [reportFailedSoFar, ...releases.slice(index + 1)],
      log,
    );
    if (released.isOk()) continue;
    if (firstFailure.isOk()) firstFailure = released;
    else log.warn({ err: released.error }, 'a further cleanup failed as well');
  }
  return firstFailure;
}
