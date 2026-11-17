import { Result } from 'better-result';
import type { Logger } from 'pino';

import type { JigError } from '../domain/errors.js';

/** A failed cleanup is the outcome only when the work itself succeeded; otherwise it is logged. */
export function reportCleanup<T, E, C extends JigError>(
  used: Result<T, E>,
  cleanup: Result<void, C>,
  logger: Logger,
): Result<T, E | C> {
  if (cleanup.isOk()) return used;
  if (used.isOk()) return Result.err(cleanup.error);
  logger.warn({ err: cleanup.error }, 'cleanup failed after the run failed');
  return used;
}
