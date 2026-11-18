import type { Result } from 'better-result';

import type { RunId } from '../domain/run-id.js';
import type { RunStoreFailure } from './run-store.js';

/** The run branch's code as a store sees it: what to record at a save, and what to restore on load. */
export interface RunCode {
  /** The commit the run branch holds here, or `undefined` before it has one. */
  checkpoint(runId: RunId): Promise<Result<string | undefined, RunStoreFailure>>;
  /**
   * Leaves the run branch at `revision`, or ahead of it with work not saved yet, from objects kept
   * here or from the branch published on the remote. Refuses code it cannot produce.
   */
  restore(runId: RunId, revision: string): Promise<Result<void, RunStoreFailure>>;
}
