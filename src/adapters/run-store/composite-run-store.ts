import { Result } from 'better-result';

import { RunStateConflict } from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { defersCodePublication, type RunState } from '../../domain/run-state.js';
import type { RunCode } from '../../ports/run-code.js';
import type { RunStore, RunStoreFailure } from '../../ports/run-store.js';

/**
 * Keeps a copy of each run in every store. A load or a peek asks every store and returns the
 * copy with the highest revision; a tie goes to the store listed first. A load also lets a
 * remote store learn what it must not overwrite. A save stamps the next revision past any this store has seen, so one
 * process never writes two different states under the same revision. A run that defers its code
 * publication records the run branch's commit at each save, and a load restores that checkpoint
 * before handing the run back, so the state never describes code this clone does not hold.
 */
export class CompositeRunStore implements RunStore {
  private readonly latestRevisions = new Map<RunId, number>();

  constructor(
    private readonly stores: RunStore[],
    private readonly code: RunCode,
  ) {}

  load(runId: RunId): Promise<Result<RunState | undefined, RunStoreFailure>> {
    return Result.gen(async function* (this: CompositeRunStore) {
      const copies = yield* Result.await(this.readEach((store) => store.load(runId)));
      const freshest = freshestOf(copies);
      if (!freshest) return Result.ok(undefined);
      this.latestRevisions.set(runId, freshest.revision);
      yield* Result.await(this.restoreCheckpoint(freshest, copies));
      return Result.ok(freshest);
    }, this);
  }

  private async readEach(
    read: (store: RunStore) => Promise<Result<RunState | undefined, RunStoreFailure>>,
  ): Promise<Result<(RunState | undefined)[], RunStoreFailure>> {
    const copies: (RunState | undefined)[] = [];
    for (const store of this.stores) {
      const copy = await read(store);
      if (copy.isErr()) return Result.err(copy.error);
      copies.push(copy.value);
    }
    return Result.ok(copies);
  }

  private async restoreCheckpoint(
    freshest: RunState,
    copies: (RunState | undefined)[],
  ): Promise<Result<void, RunStoreFailure>> {
    const { runId, codeRevision } = freshest;
    if (!defersCodePublication(freshest) || !codeRevision) return Result.ok();
    const disagreeing = copies.find(
      (copy) => copy?.revision === freshest.revision && copy.codeRevision !== codeRevision,
    );
    if (disagreeing)
      return Result.err(
        new RunStateConflict({
          message: `Run ${runId} has two copies at revision ${freshest.revision} with different code checkpoints (${codeRevision}, ${disagreeing.codeRevision ?? 'none'}).`,
        }),
      );
    return this.code.restore(runId, codeRevision);
  }

  async peek(runId: RunId): Promise<Result<RunState | undefined, RunStoreFailure>> {
    const copies = await this.readEach((store) => store.peek(runId));
    return copies.map(freshestOf);
  }

  async save(state: RunState): Promise<Result<void, RunStoreFailure>> {
    const checkpointed = await this.withCodeCheckpoint(state);
    if (checkpointed.isErr()) return Result.err(checkpointed.error);
    const revision = Math.max(state.revision, this.latestRevisions.get(state.runId) ?? 0) + 1;
    this.latestRevisions.set(state.runId, revision);
    const stamped = { ...checkpointed.value, revision };
    for (const store of this.stores) {
      const saved = await store.save(stamped);
      if (saved.isErr()) return saved;
    }
    return Result.ok();
  }

  private async withCodeCheckpoint(state: RunState): Promise<Result<RunState, RunStoreFailure>> {
    if (!defersCodePublication(state)) return Result.ok(state);
    const checkpoint = await this.code.checkpoint(state.runId);
    return checkpoint.map((codeRevision) => (codeRevision ? { ...state, codeRevision } : state));
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
