import { Result } from 'better-result';
import { execa } from 'execa';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CommitImportRefused,
  GitCommandFailed,
  MergeFailed,
  type RemoteUnavailable,
} from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import type { CommitSummary } from '../../domain/usage.js';
import { isBranchMergedInto, mergeBranchInto } from '../../git/merge.js';
import { gitCommand, openRepo, openRepoWithoutHooks } from '../../git/repository.js';
import type { SandboxGit } from '../../ports/sandbox-git.js';
import type { Workspace } from '../../ports/workspace.js';

export interface GitWorkspaceOptions {
  repoRoot: string;
  worktreePath: string;
  runId: RunId;
  baseBranch: string;
  sandbox: SandboxGit;
}

export class GitWorkspace implements Workspace {
  private readonly runBranch: string;

  constructor(private readonly options: GitWorkspaceOptions) {
    this.runBranch = runBranchFor(options.runId);
  }

  saveWork(
    message: string,
    { approved }: { approved: string },
  ): Promise<Result<void, GitCommandFailed | CommitImportRefused>> {
    return Result.gen(async function* (this: GitWorkspace) {
      yield* Result.await(this.commitInSandbox(message));
      yield* Result.await(this.importCommits(approved));
      return Result.ok();
    }, this);
  }

  private async commitInSandbox(message: string): Promise<Result<void, GitCommandFailed>> {
    const status = await this.sandboxGit(['status', '--porcelain']);
    if (status.isErr() || status.value === '') return status.map(() => undefined);
    const added = await this.sandboxGit(['add', '-A']);
    if (added.isErr()) return added.map(() => undefined);
    return (await this.sandboxGit(['commit', '-q', '-m', message])).map(() => undefined);
  }

  private async sandboxGit(args: string[]): Promise<Result<string, GitCommandFailed>> {
    const { exitCode, output } = await this.options.sandbox.execGit(args);
    return exitCode === 0
      ? Result.ok(output.trim())
      : Result.err(
          new GitCommandFailed({
            message: `git ${args[0]} failed in the sandbox: ${output.trim()}`,
            command: args[0],
            stderr: output,
          }),
        );
  }

  /**
   * Commits cross as a bundle, read as data: the host never opens the sandbox's repository, and
   * believes nothing it reports until the fetched commits bear it out.
   */
  private importCommits(
    approved: string,
  ): Promise<Result<void, GitCommandFailed | CommitImportRefused>> {
    return Result.gen(async function* (this: GitWorkspace) {
      const head = yield* Result.await(this.sandboxGit(['rev-parse', 'HEAD']));
      if (!FULL_SHA.test(head)) {
        return Result.err(
          new CommitImportRefused({ message: 'The sandbox did not report a commit as its head.' }),
        );
      }
      if (head === (yield* Result.await(this.headCommit()))) return Result.ok();
      if (head === approved) return this.moveRunBranchTo(approved);
      const fetched = yield* Result.await(this.fetchFromSandbox(approved));
      if (fetched !== head) {
        return Result.err(
          new CommitImportRefused({
            message: `The sandbox reported ${head} as its head, but its bundle holds ${fetched}.`,
          }),
        );
      }
      if (!(yield* Result.await(this.descendsFrom(fetched, approved)))) {
        return Result.err(
          new CommitImportRefused({
            message: `The sandbox rewrote approved commit ${approved}, so its work was not taken.`,
          }),
        );
      }
      return this.moveRunBranchTo(fetched);
    }, this);
  }

  private moveRunBranchTo(commit: string): Promise<Result<void, GitCommandFailed>> {
    return gitCommand('reset', async () => {
      await openRepoWithoutHooks(this.options.worktreePath).raw(['reset', '-q', '--hard', commit]);
    });
  }

  private fetchFromSandbox(approved: string): Promise<Result<string, GitCommandFailed>> {
    return Result.gen(async function* (this: GitWorkspace) {
      const directory = await mkdtemp(path.join(tmpdir(), 'jig-import-'));
      try {
        const hostBundle = path.join(directory, 'out.bundle');
        yield* Result.await(
          this.sandboxGit([
            'bundle',
            'create',
            '-q',
            OUTGOING_BUNDLE,
            this.runBranch,
            `^${approved}`,
          ]),
        );
        yield* Result.await(this.options.sandbox.copyOut(OUTGOING_BUNDLE, hostBundle));
        return gitCommand('fetch', async () => {
          const git = openRepoWithoutHooks(this.options.worktreePath);
          await git.raw([
            '-c',
            'fetch.fsckObjects=true',
            'fetch',
            '-q',
            hostBundle,
            this.runBranch,
          ]);
          return (await git.revparse(['FETCH_HEAD'])).trim();
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, this);
  }

  private async descendsFrom(
    commit: string,
    ancestor: string,
  ): Promise<Result<boolean, GitCommandFailed>> {
    const { exitCode, stderr } = await execa(
      'git',
      ['merge-base', '--is-ancestor', ancestor, commit],
      { cwd: this.options.repoRoot, reject: false },
    );
    if (exitCode === 0 || exitCode === 1) return Result.ok(exitCode === 0);
    return Result.err(
      new GitCommandFailed({
        message: `git merge-base failed: ${stderr}`,
        command: 'merge-base',
        stderr,
      }),
    );
  }

  headCommit(): Promise<Result<string, GitCommandFailed>> {
    return gitCommand('rev-parse', async () =>
      (await openRepo(this.options.repoRoot).revparse([this.runBranch])).trim(),
    );
  }

  forkPoint(): Promise<Result<string, GitCommandFailed>> {
    return gitCommand('merge-base', async () => {
      const forkPoint = await openRepo(this.options.repoRoot).raw([
        'merge-base',
        this.options.baseBranch,
        this.runBranch,
      ]);
      return forkPoint.trim();
    });
  }

  summariseCommitsSince(since: string): Promise<Result<CommitSummary, GitCommandFailed>> {
    return Result.gen(async function* (this: GitWorkspace) {
      const sha = yield* Result.await(this.headCommit());
      const diff = yield* Result.await(
        gitCommand('diff', () => openRepo(this.options.repoRoot).diffSummary([since, sha])),
      );
      return Result.ok({
        sha,
        filesChanged: diff.changed,
        insertions: diff.insertions,
        deletions: diff.deletions,
      });
    }, this);
  }

  async readRepoFile(relativePath: string): Promise<string | undefined> {
    try {
      return await readFile(path.join(this.options.repoRoot, relativePath), 'utf-8');
    } catch {
      return undefined;
    }
  }

  async mergeRunBranch(): Promise<Result<void, MergeFailed>> {
    const { repoRoot, baseBranch } = this.options;
    const merged = await mergeBranchInto(repoRoot, this.runBranch, baseBranch);
    if (merged.isOk()) return Result.ok();
    await abortMergeInProgress(repoRoot);
    return Result.err(
      new MergeFailed({
        message: `Merging "${this.runBranch}" into "${baseBranch}" failed: ${merged.error.message}`,
      }),
    );
  }

  isRunBranchMerged(): Promise<Result<boolean, GitCommandFailed | RemoteUnavailable>> {
    return isBranchMergedInto(this.options.repoRoot, this.runBranch, this.options.baseBranch);
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Inside the clone's `.git`, so a bundle can never be committed by `git add -A`. */
const OUTGOING_BUNDLE = '.git/jig-out.bundle';

/** Leaves the operator's repository as it was; there is nothing to abort when git never started merging. */
async function abortMergeInProgress(repoRoot: string): Promise<void> {
  await openRepo(repoRoot)
    .raw(['merge', '--abort'])
    .catch(() => undefined);
}

//END
