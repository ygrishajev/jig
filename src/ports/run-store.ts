import type { RunId } from '../domain/run-id.js';
import type { RunState } from '../domain/run-state.js';

/** Where run state lives between invocations. Saved after every transition. */
export interface RunStore {
  /** Reads the run to carry on with it; may bring this machine's copy of it up to date. */
  load(runId: RunId): Promise<RunState | undefined>;
  /** Reads the run and changes nothing on this machine: for looking, not resuming. */
  peek(runId: RunId): Promise<RunState | undefined>;
  save(state: RunState): Promise<void>;
}
