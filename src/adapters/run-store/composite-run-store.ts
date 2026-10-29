import type { RunState } from '../../domain/run-state.js';
import type { RunStore } from '../../ports/run-store.js';

/**
 * Keeps a copy of each run in every store. A load asks every store, so a remote store learns
 * what it must not overwrite, and returns the copy with the highest revision; a tie goes to the
 * store listed first. A save stamps the next revision past any this store has seen, so one
 * process never writes two different states under the same revision.
 */
export class CompositeRunStore implements RunStore {
  private readonly latestRevisions = new Map<string, number>();

  constructor(private readonly stores: RunStore[]) {}

  async load(runId: string) {
    let freshest: RunState | undefined;
    for (const store of this.stores) {
      const copy = await store.load(runId);
      if (copy && (!freshest || copy.revision > freshest.revision)) freshest = copy;
    }
    if (freshest) this.latestRevisions.set(runId, freshest.revision);
    return freshest;
  }

  async save(state: RunState) {
    const revision = Math.max(state.revision, this.latestRevisions.get(state.runId) ?? 0) + 1;
    this.latestRevisions.set(state.runId, revision);
    const stamped = { ...state, revision };
    for (const store of this.stores) await store.save(stamped);
  }
}
