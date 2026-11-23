import { Result } from 'better-result';

import type { RunId } from '../../domain/run-id.js';
import {
  canRecoverInitialCheckpoint,
  defersCodePublication,
  type RunState,
} from '../../domain/run-state.js';
import type { GitCommandFailed } from '../../ports/git-failures.js';
import type { RunCode, RunCodeRestoreFailure } from '../../ports/run-code.js';
import { RunCodeUnavailable, RunStateConflict } from '../../ports/run-state-failures.js';
import type { RunStore, RunStoreFailure } from '../../ports/run-store.js';

/**
 * Keeps a copy of each run in every store. A load or a peek asks every store and returns the
 * copy with the highest revision; copies tied at that revision must agree on how and where the
 * run's code is published, so the store order never decides which code a run resumes with. A load
 * also lets a remote store learn what it must not overwrite. A save stamps the next revision past any this store has seen, so one
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
      const freshest = yield* consistentFreshestOf(copies);
      if (!freshest) return Result.ok(undefined);
      this.latestRevisions.set(runId, freshest.revision);
      return this.restoreCheckpoint(freshest);
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

  private restoreCheckpoint(state: RunState): Promise<Result<RunState, RunCodeRestoreFailure>> {
    return Result.gen(async function* (this: CompositeRunStore) {
      if (!defersCodePublication(state)) return Result.ok(state);
      const checkpointed = yield* recordedCheckpoint(state);
      yield* Result.await(this.code.restore(state.runId, checkpointed.codeRevision));
      return Result.ok(checkpointed);
    }, this);
  }

  async peek(runId: RunId): Promise<Result<RunState | undefined, RunStoreFailure>> {
    const copies = await this.readEach((store) => store.peek(runId));
    return copies.andThen(consistentFreshestOf);
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

  private async withCodeCheckpoint(
    state: RunState,
  ): Promise<Result<RunState, GitCommandFailed | RunCodeUnavailable>> {
    if (!defersCodePublication(state)) return Result.ok(state);
    const checkpoint = await this.code.checkpoint(state.runId);
    return checkpoint.andThen((codeRevision) =>
      recordedCheckpoint(codeRevision ? { ...state, codeRevision } : state),
    );
  }
}

/**
 * The copy with the highest revision, listed first on a tie, once every tied copy agrees on its code
 * publication policy and checkpoint; disagreeing copies would let store order pick the run's code.
 */
function consistentFreshestOf(
  copies: (RunState | undefined)[],
): Result<RunState | undefined, RunStateConflict> {
  const freshest = freshestOf(copies);
  const disagreeing = copies.find(
    (copy) => copy && freshest && copy.revision === freshest.revision && !sameCode(copy, freshest),
  );
  if (!freshest || !disagreeing) return Result.ok(freshest);
  return Result.err(
    new RunStateConflict({
      message: `Run ${freshest.runId} has two copies at revision ${freshest.revision} that disagree on its code (${codeOf(freshest)}; ${codeOf(disagreeing)}).`,
    }),
  );
}

function freshestOf(copies: (RunState | undefined)[]): RunState | undefined {
  let freshest: RunState | undefined;
  for (const copy of copies) {
    if (copy && (!freshest || copy.revision > freshest.revision)) freshest = copy;
  }
  return freshest;
}

function sameCode(first: RunState, second: RunState): boolean {
  return (
    first.codePublication === second.codePublication &&
    first.startingCommit === second.startingCommit &&
    first.codeRevision === second.codeRevision
  );
}

function codeOf({ codePublication, codeRevision }: RunState): string {
  return `${codePublication ?? 'published with state'}, checkpoint ${codeRevision ?? 'none'}`;
}

function recordedCheckpoint(
  state: RunState,
): Result<RunState & { codeRevision: string }, RunCodeUnavailable> {
  const codeRevision =
    state.codeRevision ?? (canRecoverInitialCheckpoint(state) ? state.startingCommit : undefined);
  if (codeRevision) return Result.ok({ ...state, codeRevision });
  return Result.err(
    new RunCodeUnavailable({
      message: `Run ${state.runId} has no trustworthy code checkpoint. Resume from a copy with a recorded codeRevision, or start a new run; the current default branch cannot recover this run's code.`,
    }),
  );
}
