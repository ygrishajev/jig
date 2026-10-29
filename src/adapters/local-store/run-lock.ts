import path from 'node:path';
import lockfile from 'proper-lockfile';
import { RunInProgress } from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { makeRunDirectory } from './run-paths.js';

/**
 * A live holder refreshes its lock every half of this; a lock left this long without a refresh
 * belongs to a process that died, and the next run takes it over.
 */
const STALE_LOCK_MS = 30_000;

/**
 * Makes this process the run's only writer until the returned release is called. A second
 * process fails at once with `RunInProgress` rather than waiting for the first to finish.
 */
export async function lockRun(repoRoot: string, runId: RunId): Promise<() => Promise<void>> {
  const directory = await makeRunDirectory(repoRoot, runId);
  try {
    return await lockfile.lock(directory, {
      lockfilePath: path.join(directory, 'run.lock'),
      realpath: false,
      stale: STALE_LOCK_MS,
      retries: 0,
    });
  } catch (error) {
    if (isHeldElsewhere(error)) {
      throw new RunInProgress(`Run "${runId}" is already running in another sdlc process.`);
    }
    throw error;
  }
}

function isHeldElsewhere(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ELOCKED';
}
