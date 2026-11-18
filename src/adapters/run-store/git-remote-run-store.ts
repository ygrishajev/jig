import { Result } from 'better-result';

import {
  ConfigInvalid,
  GitCommandFailed,
  messageOf,
  RemoteUnavailable,
  RunStateConflict,
} from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import {
  defersCodePublication,
  runBranchFor,
  type RunState,
  runStateSchema,
} from '../../domain/run-state.js';
import type { RunStore, RunStoreFailure } from '../../ports/run-store.js';
import { RemoteRef } from '../git/remote-ref.js';
import { isAncestor } from '../git/repository.js';

/** What the remote held for a run when this store last looked or pushed; a save leases against it. */
interface RemoteRun {
  state?: string;
  branch?: string;
}

/**
 * Keeps each run's state as a commit on a hidden `refs/jig/<runId>` ref and pushes it, with the
 * run branch, to a remote — so another machine, such as a retried CI job, can resume the run.
 * The hidden ref keeps state commits out of the repository's branch list. A save only replaces
 * what this store last saw on the remote, so a concurrent writer is refused rather than overwritten.
 * A run that defers its code publication pushes its state alone: the branch stays on this clone.
 */
export class GitRemoteRunStore implements RunStore {
  private readonly seenOnRemote = new Map<RunId, RemoteRun>();

  private readonly refs: RemoteRef;

  constructor(
    private readonly repoRoot: string,
    private readonly remote = 'origin',
  ) {
    this.refs = new RemoteRef(repoRoot, remote);
  }

  load(runId: RunId): Promise<Result<RunState | undefined, RunStoreFailure>> {
    return Result.gen(async function* (this: GitRemoteRunStore) {
      const remoteRun = yield* Result.await(this.fetchRun(runId));
      this.seenOnRemote.set(runId, remoteRun);
      if (!remoteRun.state) return Result.ok(undefined);
      if (remoteRun.branch) yield* Result.await(this.catchUpRunBranch(runId, remoteRun.branch));
      const shown = yield* Result.await(
        this.refs.required(['show', `${stateRef(runId)}:${STATE_FILE}`]),
      );
      return parseState(shown, this.remote);
    }, this);
  }

  /** Brings the run's refs over from the remote; the run branch lands on a remote-tracking ref. */
  private fetchRun(runId: RunId): Promise<Result<RemoteRun, RunStateConflict | RemoteUnavailable>> {
    return Result.gen(async function* (this: GitRemoteRunStore) {
      const refsOnRemote = yield* Result.await(this.refs.list([stateRef(runId), branchRef(runId)]));
      if (!refsOnRemote.has(stateRef(runId))) return Result.ok({});
      const hasBranch = refsOnRemote.has(branchRef(runId));
      yield* Result.await(
        this.refs.fetch([
          `+${stateRef(runId)}:${stateRef(runId)}`,
          ...(hasBranch ? [`+${branchRef(runId)}:${this.trackingRef(runId)}`] : []),
        ]),
      );
      return Result.ok({
        state: await this.refs.revision(stateRef(runId)),
        branch: hasBranch ? await this.refs.revision(this.trackingRef(runId)) : undefined,
      });
    }, this);
  }

  private trackingRef(runId: RunId): string {
    return `refs/remotes/${this.remote}/${runBranchFor(runId)}`;
  }

  /**
   * Moves the local run branch to the remote's when it is behind, keeps it when it is ahead with
   * commits not pushed yet, and refuses when the two have diverged.
   */
  private catchUpRunBranch(
    runId: RunId,
    remoteHead: string,
  ): Promise<Result<void, RunStateConflict | GitCommandFailed>> {
    return Result.gen(async function* (this: GitRemoteRunStore) {
      const local = await this.refs.revision(branchRef(runId));
      if (!local) {
        return (await this.refs.required(['update-ref', branchRef(runId), remoteHead, ''])).map(
          () => undefined,
        );
      }
      const remoteIsAncestor = yield* Result.await(isAncestor(this.repoRoot, remoteHead, local));
      if (remoteIsAncestor) return Result.ok();
      const localIsAncestor = yield* Result.await(isAncestor(this.repoRoot, local, remoteHead));
      if (!localIsAncestor) {
        return Result.err(
          new RunStateConflict({
            message: `The run branch "${runBranchFor(runId)}" here and on ${this.remote} have diverged.`,
          }),
        );
      }
      return this.fastForward(runId, local, remoteHead);
    }, this);
  }

  /** Git refuses to move a branch a worktree has checked out, so that worktree is moved instead. */
  private async fastForward(
    runId: RunId,
    from: string,
    to: string,
  ): Promise<Result<void, GitCommandFailed>> {
    const worktree = await this.worktreeWithCheckedOut(branchRef(runId));
    if (worktree.isErr()) return Result.err(worktree.error);
    const moved = worktree.value
      ? await this.refs.required(['-C', worktree.value, 'merge', '--ff-only', '--quiet', to])
      : await this.refs.required(['update-ref', branchRef(runId), to, from]);
    return moved.map(() => undefined);
  }

  private async worktreeWithCheckedOut(
    ref: string,
  ): Promise<Result<string | undefined, GitCommandFailed>> {
    const listed = await this.refs.required(['worktree', 'list', '--porcelain']);
    return listed.map((output) => {
      const entry = output
        .split('\n\n')
        .map((block) => block.split('\n'))
        .find((lines) => lines.includes(`branch ${ref}`));
      return entry?.[0]?.replace(/^worktree /, '');
    });
  }

  /** Reads the remote's copy without creating or moving a ref here, not even FETCH_HEAD. */
  peek(runId: RunId): Promise<Result<RunState | undefined, RunStoreFailure>> {
    return Result.gen(async function* (this: GitRemoteRunStore) {
      const files = yield* Result.await(this.refs.peek(stateRef(runId)));
      if (!files) return Result.ok(undefined);
      const shown = files.get(STATE_FILE) ?? '';
      return parseState(shown, this.remote);
    }, this);
  }

  save(state: RunState): Promise<Result<void, RunStoreFailure>> {
    return Result.gen(async function* (this: GitRemoteRunStore) {
      const commit = yield* Result.await(
        this.refs.commitFile(
          stateRef(state.runId),
          STATE_FILE,
          `${JSON.stringify(state, null, 2)}\n`,
          `jig run ${state.runId}: ${state.phase}`,
        ),
      );
      const branch = defersCodePublication(state)
        ? undefined
        : await this.refs.revision(branchRef(state.runId));
      const lease = this.seenOnRemote.get(state.runId) ?? {};
      yield* Result.await(
        this.refs.pushLeased([
          { ref: stateRef(state.runId), expected: lease.state, source: stateRef(state.runId) },
          ...(branch
            ? [
                {
                  ref: branchRef(state.runId),
                  expected: lease.branch,
                  source: branchRef(state.runId),
                },
              ]
            : []),
        ]),
      );
      this.seenOnRemote.set(state.runId, { state: commit, branch: branch ?? lease.branch });
      return Result.ok();
    }, this);
  }
}

function stateRef(runId: RunId): string {
  return `refs/jig/${runId}`;
}

const STATE_FILE = 'run.json';

function parseState(shown: string, remote: string): Result<RunState, ConfigInvalid> {
  return Result.try({
    try: () => runStateSchema.parse(JSON.parse(shown)),
    catch: (cause) =>
      new ConfigInvalid({
        message: `The run's state on ${remote} is not valid: ${messageOf(cause)}`,
      }),
  });
}

function branchRef(runId: RunId): string {
  return `refs/heads/${runBranchFor(runId)}`;
}
