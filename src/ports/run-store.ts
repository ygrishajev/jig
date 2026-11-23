import type { Result } from 'better-result';

import type { RunId } from '../domain/run-id.js';
import type { RunState } from '../domain/run-state.js';
import type { LocalStateUnwritable } from './filesystem.js';
import type { GitCommandFailed, RemoteUnavailable } from './git-failures.js';
import type {
  RunCodeUnavailable,
  RunStateConflict,
  RunStateInvalid,
  RunStoreFailed,
} from './run-state-failures.js';

/** Where run state lives between invocations. Saved after every transition. */
export interface RunStore {
  /** Reads the run to carry on with it; may bring this machine's copy of it up to date. */
  load(runId: RunId): Promise<Result<RunState | undefined, RunStoreLoadFailure>>;
  /** Reads the run and changes nothing on this machine: for looking, not resuming. */
  peek(runId: RunId): Promise<Result<RunState | undefined, RunStorePeekFailure>>;
  save(state: RunState): Promise<Result<void, RunStoreSaveFailure>>;
}

export type RunStoreLoadFailure = RunStorePeekFailure | RunCodeUnavailable;
export type RunStorePeekFailure =
  | RunStateConflict
  | RemoteUnavailable
  | GitCommandFailed
  | LocalStateUnwritable
  | RunStateInvalid
  | RunStoreFailed;
export type RunStoreSaveFailure =
  | RunStateConflict
  | RemoteUnavailable
  | GitCommandFailed
  | LocalStateUnwritable
  | RunCodeUnavailable
  | RunStoreFailed;
