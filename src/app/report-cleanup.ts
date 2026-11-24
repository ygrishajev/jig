import { Result } from 'better-result';

import type { WarningLog } from '../ports/observability.js';

/** A failed cleanup is the outcome only when the work itself succeeded; otherwise it is logged. */
export function reportCleanup<T, E, C>(
  used: Result<T, E>,
  cleanup: Result<void, C>,
  log: WarningLog,
): Result<T, E | C> {
  if (cleanup.isOk()) return used;
  if (used.isOk()) return Result.err(cleanup.error);
  log.warn({ err: cleanup.error }, 'cleanup failed after the run failed');
  return used;
}
