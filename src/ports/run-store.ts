import type { RunId } from '../domain/run-id.js';
import type { RunState } from '../domain/run-state.js';

/** Where run state lives between invocations. Saved after every transition. */
export interface RunStore {
  load(runId: RunId): Promise<RunState | undefined>;
  save(state: RunState): Promise<void>;
}
