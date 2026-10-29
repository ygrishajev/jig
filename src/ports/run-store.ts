import type { RunState } from '../domain/run-state.js';

/** Where run state lives between invocations. Saved after every transition. */
export interface RunStore {
  load(runId: string): Promise<RunState | undefined>;
  save(state: RunState): Promise<void>;
}
