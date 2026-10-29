import type { RunState } from '../../domain/run-state.js';
import type { RunStore } from '../../ports/run-store.js';

/**
 * Saves to every store in order and loads from the first one that has the run. Every store still
 * loads it, so a remote store learns what it must not overwrite before its first save.
 */
export class CompositeRunStore implements RunStore {
  constructor(private readonly stores: RunStore[]) {}

  async load(runId: string) {
    const loaded: (RunState | undefined)[] = [];
    for (const store of this.stores) loaded.push(await store.load(runId));
    return loaded.find((state) => state !== undefined);
  }

  async save(state: RunState) {
    for (const store of this.stores) await store.save(state);
  }
}
