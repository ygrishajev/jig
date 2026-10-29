import { execa } from 'execa';
import { runBranchFor, type RunState } from '../../domain/run-state.js';
import type { RunStore } from '../../ports/run-store.js';
import { runStateSchema } from '../local-store/run-state-schema.js';

const STATE_FILE = 'run.json';

/** Identity for the state commits; they are sdlc's bookkeeping, not anyone's work. */
const COMMITTER = {
  GIT_AUTHOR_NAME: 'sdlc',
  GIT_AUTHOR_EMAIL: 'sdlc@localhost',
  GIT_COMMITTER_NAME: 'sdlc',
  GIT_COMMITTER_EMAIL: 'sdlc@localhost',
};

/**
 * Keeps each run's state as a commit on a hidden `refs/sdlc/<runId>` ref and pushes it, with the
 * run branch, to a remote — so another machine, such as a retried CI job, can resume the run.
 * The hidden ref keeps state commits out of the repository's branch list.
 */
export class GitRemoteRunStore implements RunStore {
  constructor(
    private readonly repoRoot: string,
    private readonly remote = 'origin',
  ) {}

  async load(runId: string) {
    const ref = stateRef(runId);
    const fetched = await this.git(['fetch', '--quiet', this.remote, `+${ref}:${ref}`]);
    if (fetched.exitCode !== 0) return undefined;
    await this.git([
      'fetch',
      '--quiet',
      this.remote,
      `${runBranchFor(runId)}:${runBranchFor(runId)}`,
    ]);
    const shown = await this.git(['show', `${ref}:${STATE_FILE}`]);
    if (shown.exitCode !== 0) return undefined;
    return runStateSchema.parse(JSON.parse(shown.stdout));
  }

  async save(state: RunState) {
    const ref = stateRef(state.runId);
    const blob = await this.required(
      ['hash-object', '-w', '--stdin'],
      `${JSON.stringify(state, null, 2)}\n`,
    );
    const tree = await this.required(['mktree'], `100644 blob ${blob}\t${STATE_FILE}\n`);
    const parent = await this.git(['rev-parse', '--verify', '--quiet', ref]);
    const commit = await this.required([
      'commit-tree',
      tree,
      ...(parent.exitCode === 0 ? ['-p', parent.stdout] : []),
      '-m',
      `sdlc run ${state.runId}: ${state.phase}`,
    ]);
    await this.required(['update-ref', ref, commit]);
    await this.required([
      'push',
      '--quiet',
      '--force',
      this.remote,
      ...(await this.refsToPush(state.runId)),
    ]);
  }

  private async refsToPush(runId: string) {
    const branch = `refs/heads/${runBranchFor(runId)}`;
    const branchExists =
      (await this.git(['rev-parse', '--verify', '--quiet', branch])).exitCode === 0;
    const ref = stateRef(runId);
    return [`${ref}:${ref}`, ...(branchExists ? [`${branch}:${branch}`] : [])];
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
      throw new Error(`git ${args[0]} failed while saving run state: ${result.stderr}`);
    }
    return result.stdout.trim();
  }
}

function stateRef(runId: string) {
  return `refs/sdlc/${runId}`;
}
