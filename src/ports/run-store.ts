import type { Result } from 'better-result';

import type {
  ConfigInvalid,
  GitCommandFailed,
  LocalStateUnwritable,
  RemoteUnavailable,
  RunCodeUnavailable,
  RunStateConflict,
} from '../domain/errors.js';
import type { RunId } from '../domain/run-id.js';
import type { RunState } from '../domain/run-state.js';

/** Where run state lives between invocations. Saved after every transition. */
export interface RunStore {
  /** Reads the run to carry on with it; may bring this machine's copy of it up to date. */
  load(runId: RunId): Promise<Result<RunState | undefined, RunStoreFailure>>;
  /** Reads the run and changes nothing on this machine: for looking, not resuming. */
  peek(runId: RunId): Promise<Result<RunState | undefined, RunStoreFailure>>;
  save(state: RunState): Promise<Result<void, RunStoreFailure>>;
}

export type RunStoreFailure =
  | RunStateConflict
  | RemoteUnavailable
  | ConfigInvalid
  | GitCommandFailed
  | LocalStateUnwritable
  | RunCodeUnavailable;
