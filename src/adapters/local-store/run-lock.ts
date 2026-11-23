import { Result } from 'better-result';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { RunId } from '../../domain/run-id.js';
import { LocalStateUnwritable } from '../../ports/filesystem.js';
import { RunInProgress } from '../../ports/run-state-failures.js';
import { messageOf } from '../exception-details.js';
import { onLocalState } from './local-state.js';
import { findLinkInRunDirectory, makeRunDirectory, runDirectory } from './run-paths.js';

/**
 * Makes this process the run's only writer until the returned release is called. A second
 * process fails at once with `RunInProgress` rather than waiting for the first to finish. Every
 * write of a run comes after this lock, so a run directory holding a link is refused here.
 */
export async function lockRun(
  repoRoot: string,
  runId: RunId,
): Promise<Result<() => Promise<void>, RunInProgress | LocalStateUnwritable>> {
  const directory = runDirectory(repoRoot, runId);
  const lockfilePath = path.join(directory, 'run.lock');
  const link = await onLocalState(directory, async () => findLinkInRunDirectory(repoRoot, runId));
  if (link.isErr()) return Result.err(link.error);
  if (link.value) {
    return Result.err(
      new LocalStateUnwritable({
        message: `Refusing to use run "${runId}": ${link.value} is a symbolic link.`,
        path: link.value,
      }),
    );
  }
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
