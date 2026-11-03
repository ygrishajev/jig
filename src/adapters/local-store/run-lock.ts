import { Result } from 'better-result';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import { LocalStateUnwritable, messageOf, RunInProgress } from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { makeRunDirectory, runDirectory } from './run-paths.js';

/**
 * Makes this process the run's only writer until the returned release is called. A second
 * process fails at once with `RunInProgress` rather than waiting for the first to finish.
 */
export async function lockRun(
  repoRoot: string,
  runId: RunId,
): Promise<Result<() => Promise<void>, RunInProgress | LocalStateUnwritable>> {
  const directory = runDirectory(repoRoot, runId);
  const lockfilePath = path.join(directory, 'run.lock');
  return Result.tryPromise({
    try: async () => {
      await makeRunDirectory(repoRoot, runId);
      return lockfile.lock(directory, {
        lockfilePath,
        realpath: false,
        stale: STALE_LOCK_MS,
        retries: 0,
      });
    },
    catch: (cause) =>
      isHeldElsewhere(cause)
        ? new RunInProgress({
            message: `Run "${runId}" is already running in another jig process.`,
          })
        : new LocalStateUnwritable({
            message: `Cannot lock run "${runId}" at ${lockfilePath}: ${messageOf(cause)}`,
            path: lockfilePath,
          }),
  });
}

/**
 * A live holder refreshes its lock every half of this; a lock left this long without a refresh
 * belongs to a process that died, and the next run takes it over.
 */
const STALE_LOCK_MS = 30_000;

function isHeldElsewhere(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ELOCKED';
}
