import { Result } from 'better-result';
import { execa, type Result as ExecaResult, type ResultPromise } from 'execa';

import {
  ConfigInvalid,
  GitCommandFailed,
  messageOf,
  RemoteUnavailable,
  RunStateConflict,
} from '../../domain/errors.js';
import { retryResult } from '../../domain/retry.js';
import type { RunId } from '../../domain/run-id.js';
import { runBranchFor, type RunState, runStateSchema } from '../../domain/run-state.js';
import type { RunStore, RunStoreFailure } from '../../ports/run-store.js';

/** What the remote held for a run when this store last looked or pushed; a save leases against it. */
interface RemoteRun {
  state?: string;
  branch?: string;
}

type GitResult = ExecaResult<{ reject: false }>;

type RemoteFailure = RunStateConflict | RemoteUnavailable;

/**
 * Keeps each run's state as a commit on a hidden `refs/jig/<runId>` ref and pushes it, with the
 * run branch, to a remote — so another machine, such as a retried CI job, can resume the run.
 * The hidden ref keeps state commits out of the repository's branch list. A save only replaces
 * what this store last saw on the remote, so a concurrent writer is refused rather than overwritten.
 */
export class GitRemoteRunStore implements RunStore {
  private readonly seenOnRemote = new Map<RunId, RemoteRun>();

  constructor(
    private readonly repoRoot: string,
    private readonly remote = 'origin',
  ) {}

  load(runId: RunId): Promise<Result<RunState | undefined, RunStoreFailure>> {
    return Result.gen(async function* (this: GitRemoteRunStore) {
      const remoteRun = yield* Result.await(this.fetchRun(runId));
      this.seenOnRemote.set(runId, remoteRun);
      if (!remoteRun.state) return Result.ok(undefined);
      if (remoteRun.branch) yield* Result.await(this.catchUpRunBranch(runId, remoteRun.branch));
      const shown = yield* Result.await(
        this.required(['show', `${stateRef(runId)}:${STATE_FILE}`]),
      );
      return parseState(shown, this.remote);
    }, this);
  }

  /** Brings the run's refs over from the remote; the run branch lands on a remote-tracking ref. */
  private fetchRun(runId: RunId): Promise<Result<RemoteRun, RemoteFailure>> {
    return Result.gen(async function* (this: GitRemoteRunStore) {
      const refsOnRemote = yield* Result.await(this.listOnRemote(runId));
      if (!refsOnRemote.has(stateRef(runId))) return Result.ok({});
      const hasBranch = refsOnRemote.has(branchRef(runId));
      yield* Result.await(
        this.remoteCall([
          'fetch',
          '--quiet',
          this.remote,
          `+${stateRef(runId)}:${stateRef(runId)}`,
          ...(hasBranch ? [`+${branchRef(runId)}:${this.trackingRef(runId)}`] : []),
        ]),
      );
      return Result.ok({
        state: await this.revision(stateRef(runId)),
        branch: hasBranch ? await this.revision(this.trackingRef(runId)) : undefined,
      });
    }, this);
  }

  /** The run's refs on the remote, each with the commit it points at. */
  private async listOnRemote(runId: RunId): Promise<Result<Map<string, string>, RemoteFailure>> {
    const listed = await this.remoteCall(
      ['ls-remote', '--exit-code', this.remote, stateRef(runId), branchRef(runId)],
      NO_MATCHING_REFS,
    );
    return listed.map((output) => {
      const entries = output.stdout
        .split('\n')
        .filter(Boolean)
        .map((line): [string, string] => {
          const [commit = '', ref = ''] = line.split('\t');
          return [ref, commit];
        });
      return new Map(entries);
    });
  }

  /** A remote operation, retried while the failure looks like the network rather than a conflict. */
  private remoteCall(
    args: string[],
    alsoAcceptedExitCode?: number,
  ): Promise<Result<GitResult, RemoteFailure>> {
    return retryResult(
      async () => {
        const result = await this.git(args);
        if (result.exitCode === 0 || result.exitCode === alsoAcceptedExitCode) {
          return Result.ok(result);
        }
        return Result.err(
          isLeaseRejection(result.stderr)
            ? new RunStateConflict({
                message: `The run's state on ${this.remote} moved since it was loaded: ${result.stderr}`,
              })
            : new RemoteUnavailable({
                message: `git ${args[0]} to ${this.remote} failed: ${result.stderr}`,
              }),
        );
      },
      {
        retries: REMOTE_RETRIES,
        delayMs: REMOTE_RETRY_DELAY_MS,
        shouldRetry: (error) => error._tag === 'RemoteUnavailable',
      },
    );
  }

  private git(args: string[], input?: string): ResultPromise<{ reject: false }> {
    return execa('git', args, {
      cwd: this.repoRoot,
      input,
      reject: false,
      env: COMMITTER,
    });
  }

  private trackingRef(runId: RunId): string {
    return `refs/remotes/${this.remote}/${runBranchFor(runId)}`;
  }

  private async revision(ref: string): Promise<string | undefined> {
    const parsed = await this.git(['rev-parse', '--verify', '--quiet', ref]);
    return parsed.exitCode === 0 ? parsed.stdout.trim() : undefined;
  }

  /**
   * Moves the local run branch to the remote's when it is behind, keeps it when it is ahead with
   * commits not pushed yet, and refuses when the two have diverged.
   */
  private async catchUpRunBranch(
    runId: RunId,
    remoteHead: string,
  ): Promise<Result<void, RunStateConflict | GitCommandFailed>> {
    const local = await this.revision(branchRef(runId));
    if (!local) {
      return (await this.required(['update-ref', branchRef(runId), remoteHead, ''])).map(
        () => undefined,
      );
    }
    if (await this.isAncestor(remoteHead, local)) return Result.ok();
    if (!(await this.isAncestor(local, remoteHead))) {
      return Result.err(
        new RunStateConflict({
          message: `The run branch "${runBranchFor(runId)}" here and on ${this.remote} have diverged.`,
        }),
      );
    }
    return this.fastForward(runId, local, remoteHead);
  }

  private async required(
    args: string[],
    input?: string,
  ): Promise<Result<string, GitCommandFailed>> {
    const result = await this.git(args, input);
    if (result.exitCode === 0) return Result.ok(result.stdout.trim());
    return Result.err(
      new GitCommandFailed({
        message: `git ${args[0]} failed on the run's state: ${result.stderr}`,
        command: `git ${args.join(' ')}`,
        stderr: result.stderr,
      }),
    );
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const checked = await this.git(['merge-base', '--is-ancestor', ancestor, descendant]);
    return checked.exitCode === 0;
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
      ? await this.required(['-C', worktree.value, 'merge', '--ff-only', '--quiet', to])
      : await this.required(['update-ref', branchRef(runId), to, from]);
    return moved.map(() => undefined);
  }

  private async worktreeWithCheckedOut(
    ref: string,
  ): Promise<Result<string | undefined, GitCommandFailed>> {
    const listed = await this.required(['worktree', 'list', '--porcelain']);
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
      const listed = yield* Result.await(this.listOnRemote(runId));
      const stateCommit = listed.get(stateRef(runId));
      if (!stateCommit) return Result.ok(undefined);
      yield* Result.await(
        this.remoteCall([
          'fetch',
          '--quiet',
          '--no-write-fetch-head',
          this.remote,
          stateRef(runId),
        ]),
      );
      const shown = yield* Result.await(this.required(['show', `${stateCommit}:${STATE_FILE}`]));
      return parseState(shown, this.remote);
    }, this);
  }

  save(state: RunState): Promise<Result<void, RunStoreFailure>> {
    return Result.gen(async function* (this: GitRemoteRunStore) {
      const commit = yield* Result.await(this.commitState(state));
      const branch = await this.revision(branchRef(state.runId));
      const lease = this.seenOnRemote.get(state.runId) ?? {};
      yield* Result.await(
        this.remoteCall([
          'push',
          '--quiet',
          '--atomic',
          `--force-with-lease=${stateRef(state.runId)}:${lease.state ?? ''}`,
          ...(branch ? [`--force-with-lease=${branchRef(state.runId)}:${lease.branch ?? ''}`] : []),
          this.remote,
          `${stateRef(state.runId)}:${stateRef(state.runId)}`,
          ...(branch ? [`${branchRef(state.runId)}:${branchRef(state.runId)}`] : []),
        ]),
      );
      this.seenOnRemote.set(state.runId, { state: commit, branch: branch ?? lease.branch });
      return Result.ok();
    }, this);
  }

  private commitState(state: RunState): Promise<Result<string, GitCommandFailed>> {
    return Result.gen(async function* (this: GitRemoteRunStore) {
      const ref = stateRef(state.runId);
      const blob = yield* Result.await(
        this.required(['hash-object', '-w', '--stdin'], `${JSON.stringify(state, null, 2)}\n`),
      );
      const tree = yield* Result.await(
        this.required(['mktree'], `100644 blob ${blob}\t${STATE_FILE}\n`),
      );
      const parent = await this.revision(ref);
      const commit = yield* Result.await(
        this.required([
          'commit-tree',
          tree,
          ...(parent ? ['-p', parent] : []),
          '-m',
          `jig run ${state.runId}: ${state.phase}`,
        ]),
      );
      yield* Result.await(this.required(['update-ref', ref, commit]));
      return Result.ok(commit);
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

/** `git ls-remote --exit-code` exits with this when the remote has none of the refs asked for. */
const NO_MATCHING_REFS = 2;

/** Git reports a push whose lease no longer matches, or that is not a fast-forward, as rejected. */
function isLeaseRejection(stderr: string): boolean {
  return stderr.includes('[rejected]') || stderr.includes('stale info');
}

/** How many more times a fetch or push that failed on the network is tried. */
const REMOTE_RETRIES = 3;

/** The wait before the first retry; each one after it waits twice as long. */
const REMOTE_RETRY_DELAY_MS = 1000;

/** Identity for the state commits; they are jig's bookkeeping, not anyone's work. */
const COMMITTER = {
  GIT_AUTHOR_NAME: 'jig',
  GIT_AUTHOR_EMAIL: 'jig@localhost',
  GIT_COMMITTER_NAME: 'jig',
  GIT_COMMITTER_EMAIL: 'jig@localhost',
};
