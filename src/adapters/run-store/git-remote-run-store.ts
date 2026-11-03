import { execa } from 'execa';
import pRetry from 'p-retry';

import { RemoteUnavailable, RunStateConflict } from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { runBranchFor, type RunState, runStateSchema } from '../../domain/run-state.js';
import type { RunStore } from '../../ports/run-store.js';

const STATE_FILE = 'run.json';

/** Identity for the state commits; they are jig's bookkeeping, not anyone's work. */
const COMMITTER = {
  GIT_AUTHOR_NAME: 'jig',
  GIT_AUTHOR_EMAIL: 'jig@localhost',
  GIT_COMMITTER_NAME: 'jig',
  GIT_COMMITTER_EMAIL: 'jig@localhost',
};

/** How many more times a fetch or push that failed on the network is tried. */
const REMOTE_RETRIES = 3;

/** `git ls-remote --exit-code` exits with this when the remote has none of the refs asked for. */
const NO_MATCHING_REFS = 2;

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
 */
export class GitRemoteRunStore implements RunStore {
  private readonly seenOnRemote = new Map<RunId, RemoteRun>();

  constructor(
    private readonly repoRoot: string,
    private readonly remote = 'origin',
  ) {}

  async load(runId: RunId) {
    const remoteRun = await this.fetchRun(runId);
    this.seenOnRemote.set(runId, remoteRun);
    if (!remoteRun.state) return undefined;
    if (remoteRun.branch) await this.catchUpRunBranch(runId, remoteRun.branch);
    return parseState(await this.required(['show', `${stateRef(runId)}:${STATE_FILE}`]));
  }

  /** Reads the remote's copy without creating or moving a ref here, not even FETCH_HEAD. */
  async peek(runId: RunId) {
    const listed = await this.listOnRemote(runId);
    const stateCommit = listed.get(stateRef(runId));
    if (!stateCommit) return undefined;
    await this.remoteCall([
      'fetch',
      '--quiet',
      '--no-write-fetch-head',
      this.remote,
      stateRef(runId),
    ]);
    return parseState(await this.required(['show', `${stateCommit}:${STATE_FILE}`]));
  }

  async save(state: RunState) {
    const commit = await this.commitState(state);
    const branch = await this.revision(branchRef(state.runId));
    const lease = this.seenOnRemote.get(state.runId) ?? {};
    await this.remoteCall([
      'push',
      '--quiet',
      '--atomic',
      `--force-with-lease=${stateRef(state.runId)}:${lease.state ?? ''}`,
      ...(branch ? [`--force-with-lease=${branchRef(state.runId)}:${lease.branch ?? ''}`] : []),
      this.remote,
      `${stateRef(state.runId)}:${stateRef(state.runId)}`,
      ...(branch ? [`${branchRef(state.runId)}:${branchRef(state.runId)}`] : []),
    ]);
    this.seenOnRemote.set(state.runId, { state: commit, branch: branch ?? lease.branch });
  }

  /** Brings the run's refs over from the remote; the run branch lands on a remote-tracking ref. */
  private async fetchRun(runId: RunId): Promise<RemoteRun> {
    const refsOnRemote = await this.listOnRemote(runId);
    if (!refsOnRemote.has(stateRef(runId))) return {};
    const hasBranch = refsOnRemote.has(branchRef(runId));
    await this.remoteCall([
      'fetch',
      '--quiet',
      this.remote,
      `+${stateRef(runId)}:${stateRef(runId)}`,
      ...(hasBranch ? [`+${branchRef(runId)}:${this.trackingRef(runId)}`] : []),
    ]);
    return {
      state: await this.revision(stateRef(runId)),
      branch: hasBranch ? await this.revision(this.trackingRef(runId)) : undefined,
    };
  }

  /** The run's refs on the remote, each with the commit it points at. */
  private async listOnRemote(runId: RunId) {
    const listed = await this.remoteCall(
      ['ls-remote', '--exit-code', this.remote, stateRef(runId), branchRef(runId)],
      NO_MATCHING_REFS,
    );
    const entries = listed.stdout
      .split('\n')
      .filter(Boolean)
      .map((line): [string, string] => {
        const [commit = '', ref = ''] = line.split('\t');
        return [ref, commit];
      });
    return new Map(entries);
  }

  /**
   * Moves the local run branch to the remote's when it is behind, keeps it when it is ahead with
   * commits not pushed yet, and refuses when the two have diverged.
   */
  private async catchUpRunBranch(runId: RunId, remoteHead: string) {
    const local = await this.revision(branchRef(runId));
    if (!local) return this.required(['update-ref', branchRef(runId), remoteHead, '']);
    if (await this.isAncestor(remoteHead, local)) return;
    if (!(await this.isAncestor(local, remoteHead))) {
      throw new RunStateConflict(
        `The run branch "${runBranchFor(runId)}" here and on ${this.remote} have diverged.`,
      );
    }
    await this.fastForward(runId, local, remoteHead);
  }

  /** Git refuses to move a branch a worktree has checked out, so that worktree is moved instead. */
  private async fastForward(runId: RunId, from: string, to: string) {
    const worktree = await this.worktreeWithCheckedOut(branchRef(runId));
    if (worktree) {
      await this.required(['-C', worktree, 'merge', '--ff-only', '--quiet', to]);
    } else {
      await this.required(['update-ref', branchRef(runId), to, from]);
    }
  }

  private async worktreeWithCheckedOut(ref: string) {
    const listed = await this.required(['worktree', 'list', '--porcelain']);
    const entry = listed
      .split('\n\n')
      .map((block) => block.split('\n'))
      .find((lines) => lines.includes(`branch ${ref}`));
    return entry?.[0]?.replace(/^worktree /, '');
  }

  private async commitState(state: RunState) {
    const ref = stateRef(state.runId);
    const blob = await this.required(
      ['hash-object', '-w', '--stdin'],
      `${JSON.stringify(state, null, 2)}\n`,
    );
    const tree = await this.required(['mktree'], `100644 blob ${blob}\t${STATE_FILE}\n`);
    const parent = await this.revision(ref);
    const commit = await this.required([
      'commit-tree',
      tree,
      ...(parent ? ['-p', parent] : []),
      '-m',
      `jig run ${state.runId}: ${state.phase}`,
    ]);
    await this.required(['update-ref', ref, commit]);
    return commit;
  }

  private trackingRef(runId: RunId) {
    return `refs/remotes/${this.remote}/${runBranchFor(runId)}`;
  }

  private async revision(ref: string) {
    const parsed = await this.git(['rev-parse', '--verify', '--quiet', ref]);
    return parsed.exitCode === 0 ? parsed.stdout.trim() : undefined;
  }

  private async isAncestor(ancestor: string, descendant: string) {
    const checked = await this.git(['merge-base', '--is-ancestor', ancestor, descendant]);
    return checked.exitCode === 0;
  }

  /** A remote operation, retried while the failure looks like the network rather than a conflict. */
  private remoteCall(args: string[], alsoAcceptedExitCode?: number) {
    return pRetry(
      async () => {
        const result = await this.git(args);
        if (result.exitCode === 0 || result.exitCode === alsoAcceptedExitCode) return result;
        throw isLeaseRejection(result.stderr)
          ? new RunStateConflict(
              `The run's state on ${this.remote} moved since it was loaded: ${result.stderr}`,
            )
          : new RemoteUnavailable(`git ${args[0]} to ${this.remote} failed: ${result.stderr}`);
      },
      {
        retries: REMOTE_RETRIES,
        shouldRetry: ({ error }) => error instanceof RemoteUnavailable,
      },
    );
  }

  private git(args: string[], input?: string) {
    return execa('git', args, {
      cwd: this.repoRoot,
      input,
      reject: false,
      env: COMMITTER,
    });
  }

  private async required(args: string[], input?: string) {
    const result = await this.git(args, input);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} failed on the run's state: ${result.stderr}`);
    }
    return result.stdout.trim();
  }
}

/** Git reports a push whose lease no longer matches, or that is not a fast-forward, as rejected. */
function isLeaseRejection(stderr: string) {
  return stderr.includes('[rejected]') || stderr.includes('stale info');
}

function parseState(shown: string) {
  return runStateSchema.parse(JSON.parse(shown));
}

function stateRef(runId: RunId) {
  return `refs/jig/${runId}`;
}

function branchRef(runId: RunId) {
  return `refs/heads/${runBranchFor(runId)}`;
}
