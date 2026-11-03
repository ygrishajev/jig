import type { RunId } from '../../domain/run-id.js';
import type { RunState } from '../../domain/run-state.js';
import type { RunStore } from '../../ports/run-store.js';

/**
 * Keeps a copy of each run in every store. A load or a peek asks every store and returns the
 * copy with the highest revision; a tie goes to the store listed first. A load also lets a
 * remote store learn what it must not overwrite. A save stamps the next revision past any this store has seen, so one
 * process never writes two different states under the same revision.
 */
export class CompositeRunStore implements RunStore {
  private readonly latestRevisions = new Map<RunId, number>();

  constructor(private readonly stores: RunStore[]) {}

  async load(runId: RunId): Promise<RunState | undefined> {
    const freshest = freshestOf(await this.readEach((store) => store.load(runId)));
    if (freshest) this.latestRevisions.set(runId, freshest.revision);
    return freshest;
  }

  private async readEach(
    read: (store: RunStore) => Promise<RunState | undefined>,
  ): Promise<(RunState | undefined)[]> {
    const copies: (RunState | undefined)[] = [];
    for (const store of this.stores) copies.push(await read(store));
    return copies;
  }

  async peek(runId: RunId): Promise<RunState | undefined> {
    return freshestOf(await this.readEach((store) => store.peek(runId)));
  }

  async save(state: RunState): Promise<void> {
    const revision = Math.max(state.revision, this.latestRevisions.get(state.runId) ?? 0) + 1;
    this.latestRevisions.set(state.runId, revision);
    const stamped = { ...state, revision };
    for (const store of this.stores) await store.save(stamped);
  }
}

/** The copy with the highest revision; on a tie, the one listed first. */
function freshestOf(copies: (RunState | undefined)[]): RunState | undefined {
  let freshest: RunState | undefined;
  for (const copy of copies) {
    if (copy && (!freshest || copy.revision > freshest.revision)) freshest = copy;
  }
  return freshest;
}
