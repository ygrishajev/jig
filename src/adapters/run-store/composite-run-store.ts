import type { RunState } from '../../domain/run-state.js';
import type { RunStore } from '../../ports/run-store.js';

/** Saves to every store in order and loads from the first one that has the run. */
export class CompositeRunStore implements RunStore {
  constructor(private readonly stores: RunStore[]) {}

  async load(runId: string) {
    for (const store of this.stores) {
      const state = await store.load(runId);
      if (state) return state;
    }
    return undefined;
  }

  async save(state: RunState) {
    for (const store of this.stores) await store.save(state);
  }
}
