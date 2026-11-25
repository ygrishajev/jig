import { type Result, TaggedError } from 'better-result';

import type { RunId } from '../domain/run-id.js';
import type { RunState } from '../domain/run-state.js';
import type { GitCommandFailed, RemoteUnavailable } from './git-failures.js';
import type { LocalStateUnwritable } from './local-state.js';
import type {
  RunCodeUnavailable,
  RunStateConflict,
  RunStateInvalid,
} from './run-state-failures.js';

/**
 * Builds the stores a run's state can be kept in: the built-in `local` and `git-remote`, or the
 * operator's own module at a path. Which stores a run uses is the caller's decision.
 */
export interface RunStoreCatalog {
  storeNamed(name: string): Promise<Result<RunStore, RunStoreSetupInvalid>>;
  /** One store over every copy: each is written, and the freshest copy wins on load. */
  combined(stores: RunStore[]): RunStore;
}

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
  | RunStateInvalid
  | RunStoreOperationFailed
  | GitCommandFailed
  | LocalStateUnwritable
  | RunCodeUnavailable;

/** The operator's own run store module threw while loading, peeking or saving a run. */
export class RunStoreOperationFailed extends TaggedError('RunStoreOperationFailed')<{
  message: string;
}> {}

/** A store named in `runStores` cannot be used: its module would not load, or is not a store. */
export class RunStoreSetupInvalid extends TaggedError('RunStoreSetupInvalid')<{
  message: string;
}> {}
