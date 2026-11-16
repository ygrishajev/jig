import { Result } from 'better-result';
import { execa } from 'execa';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CommitImportRefused,
  CommitRejected,
  GitCommandFailed,
  LocalStateUnwritable,
  MergeFailed,
  messageOf,
  type RemoteUnavailable,
  type SandboxUnavailable,
} from '../../domain/errors.js';
import type { ChangedFile, ChangeKind } from '../../domain/protected-paths.js';
import type { RunId } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import type { CommitSummary } from '../../domain/usage.js';
import type { GitFacts, WorkFacts } from '../../domain/work-facts.js';
import { isBranchMergedInto, mergeBranchInto } from '../../git/merge.js';
import {
  gitCommand,
  isWorkingTreeClean,
  openRepo,
  openRepoWithoutHooks,
} from '../../git/repository.js';
import type { SandboxGit } from '../../ports/sandbox-git.js';
import type { SaveWorkFailure, Workspace } from '../../ports/workspace.js';

export interface GitWorkspaceOptions {
  repoRoot: string;
  worktreePath: string;
  runId: RunId;
  baseBranch: string;
  sandbox: SandboxGit;
  signing: CommitSigning;
}

/** `repo` signs the run branch with the repository's setup when jig merges it; `skip` never does. */
export type CommitSigning = 'repo' | 'skip';

export class GitWorkspace implements Workspace {
  private readonly runBranch: string;

  constructor(private readonly options: GitWorkspaceOptions) {
    this.runBranch = runBranchFor(options.runId);
  }

  saveWork(
    message: string,
    { approved }: { approved: string },
  ): Promise<Result<void, SaveWorkFailure>> {
    return Result.gen(async function* (this: GitWorkspace) {
      yield* Result.await(this.commitInSandbox(message));
      yield* Result.await(this.importCommits(approved));
      return Result.ok();
    }, this);
  }

  private async commitInSandbox(
    message: string,
  ): Promise<Result<void, GitCommandFailed | CommitRejected | SandboxUnavailable>> {
    const status = await this.sandboxGit(['status', '--porcelain']);
    if (status.isErr() || status.value === '') return status.map(() => undefined);
    const added = await this.sandboxGit(['add', '-A']);
    if (added.isErr()) return added.map(() => undefined);
    const committed = await this.options.sandbox.execGit(['commit', '-q', '-m', message]);
    if (committed.isErr()) return Result.err(committed.error);
    const { exitCode, output } = committed.value;
    return exitCode === 0
      ? Result.ok()
      : Result.err(
          new CommitRejected({
            message: `The repository's commit hooks rejected the commit: ${output.trim()}`,
            output: output.trim(),
          }),
        );
  }

  private async sandboxGit(
    args: string[],
  ): Promise<Result<string, GitCommandFailed | SandboxUnavailable>> {
    const ran = await this.options.sandbox.execGit(args);
    if (ran.isErr()) return Result.err(ran.error);
    const { exitCode, output } = ran.value;
    return exitCode === 0
      ? Result.ok(output.trim())
      : Result.err(
          new GitCommandFailed({
            message: `git ${args[0]} failed in the sandbox: ${output.trim()}`,
            command: `git ${args.join(' ')}`,
            output,
          }),
        );
  }

  /**
   * Commits cross as a bundle, read as data: the host never opens the sandbox's repository, and
   * believes nothing it reports until the fetched commits bear it out.
   */
  private importCommits(approved: string): Promise<Result<void, SaveWorkFailure>> {
    return Result.gen(async function* (this: GitWorkspace) {
      const head = yield* Result.await(this.sandboxGit(['rev-parse', 'HEAD']));
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
      if (!(await this.descendsFrom(fetched, approved))) {
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

  private fetchFromSandbox(
    approved: string,
  ): Promise<Result<string, GitCommandFailed | SandboxUnavailable | LocalStateUnwritable>> {
    return Result.gen(async function* (this: GitWorkspace) {
      const directory = yield* Result.await(makeImportDirectory());
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
        await removeImportDirectory(directory);
      }
    }, this);
  }

  private async descendsFrom(commit: string, ancestor: string): Promise<boolean> {
    const { exitCode } = await execa('git', ['merge-base', '--is-ancestor', ancestor, commit], {
      cwd: this.options.repoRoot,
      reject: false,
    });
    return exitCode === 0;
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

  changedFilesSince(start: string): Promise<Result<ChangedFile[], GitCommandFailed>> {
    return Result.gen(async function* (this: GitWorkspace) {
      const head = yield* Result.await(this.headCommit());
      return gitCommand('diff', async () =>
        parseChangedFiles(
          await openRepoWithoutHooks(this.options.worktreePath).raw([
            'diff',
            '--name-status',
            '-M',
            '-z',
            start,
            head,
          ]),
        ),
      );
    }, this);
  }

  async readRepoFile(relativePath: string): Promise<string | undefined> {
    try {
      return await readFile(path.join(this.options.repoRoot, relativePath), 'utf-8');
    } catch {
      return undefined;
    }
  }

  collectFacts(): Promise<Result<WorkFacts, GitCommandFailed | SandboxUnavailable>> {
    return Result.gen(async function* (this: GitWorkspace) {
      return Result.ok({
        host: yield* Result.await(this.hostFacts()),
        sandbox: yield* Result.await(this.sandboxFacts()),
      });
    }, this);
  }

  /** The run branch as the host holds it: its tip, the content that tip holds, and whether its worktree is clean. */
  private hostFacts(): Promise<Result<GitFacts, GitCommandFailed>> {
    return Result.gen(async function* (this: GitWorkspace) {
      const commit = yield* Result.await(
        gitCommand('rev-parse', () => openRepo(this.options.repoRoot).revparse([this.runBranch])),
      );
      const tree = yield* Result.await(
        gitCommand('rev-parse', () =>
          openRepo(this.options.repoRoot).revparse([`${this.runBranch}^{tree}`]),
        ),
      );
      const clean = yield* Result.await(isWorkingTreeClean(this.options.worktreePath));
      return Result.ok({ commit: commit.trim(), tree: tree.trim(), clean });
    }, this);
  }

  /** The sandbox clone as it stands: its head, the content that head holds, and whether it is clean. */
  private sandboxFacts(): Promise<Result<GitFacts, GitCommandFailed | SandboxUnavailable>> {
    return Result.gen(async function* (this: GitWorkspace) {
      const commit = yield* Result.await(this.sandboxGit(['rev-parse', 'HEAD']));
      const tree = yield* Result.await(this.sandboxGit(['rev-parse', 'HEAD^{tree}']));
      const status = yield* Result.await(this.sandboxGit(['status', '--porcelain']));
      return Result.ok({ commit, tree, clean: status === '' });
    }, this);
  }

  async mergeRunBranch({
    approved,
  }: {
    approved: string | undefined;
  }): Promise<Result<void, MergeFailed>> {
    const { repoRoot, baseBranch, signing } = this.options;
    const tip = await this.refuseUnapprovedTip(approved);
    if (tip.isErr()) return tip;
    if (signing === 'repo') {
      const signed = await this.signRunBranch();
      if (signed.isErr()) return signed;
    }
    const merged = await mergeBranchInto(repoRoot, this.runBranch, baseBranch, {
      sign: signing === 'repo',
    });
    if (merged.isOk()) return Result.ok();
    await abortMergeInProgress(repoRoot);
    return Result.err(
      new MergeFailed({
        message: `Merging "${this.runBranch}" into "${baseBranch}" failed: ${merged.error.message}`,
      }),
    );
  }

  /** By content, not SHA: signing rewrites the commits, and a merge may be tried again after it. */
  private async refuseUnapprovedTip(
    approved: string | undefined,
  ): Promise<Result<void, MergeFailed>> {
    const trees = await gitCommand('rev-parse', async () => {
      const git = openRepo(this.options.repoRoot);
      return [
        await git.revparse([`${this.runBranch}^{tree}`]),
        approved && (await git.revparse([`${approved}^{tree}`])),
      ];
    });
    if (trees.isErr()) return Result.err(new MergeFailed({ message: trees.error.message }));
    return trees.value[0] === trees.value[1]
      ? Result.ok()
      : Result.err(
          new MergeFailed({
            message: `Refusing to merge "${this.runBranch}": its tip is not the last approved commit.`,
          }),
        );
  }

  /** Runs only when the operator asked, and only now, so SHAs stay stable for the whole run. */
  private async signRunBranch(): Promise<Result<void, MergeFailed>> {
    const forkPoint = await this.forkPoint();
    if (forkPoint.isErr()) return Result.err(new MergeFailed({ message: forkPoint.error.message }));
    const git = openRepoWithoutHooks(this.options.worktreePath);
    const signed = await gitCommand('rebase', () =>
      git.raw(['rebase', '-q', '--force-rebase', '--gpg-sign', forkPoint.value]),
    );
    if (signed.isOk()) return Result.ok();
    await git.raw(['rebase', '--abort']).catch(() => undefined);
    return Result.err(
      new MergeFailed({ message: `Could not sign "${this.runBranch}": ${signed.error.message}` }),
    );
  }

  isRunBranchMerged(): Promise<Result<boolean, GitCommandFailed | RemoteUnavailable>> {
    return isBranchMergedInto(this.options.repoRoot, this.runBranch, this.options.baseBranch);
  }
}

function makeImportDirectory(): Promise<Result<string, LocalStateUnwritable>> {
  const prefix = path.join(tmpdir(), 'jig-import-');
  return Result.tryPromise({
    try: () => mkdtemp(prefix),
    catch: (cause) =>
      new LocalStateUnwritable({
        message: `Cannot make a directory for the sandbox's commits: ${messageOf(cause)}`,
        path: prefix,
      }),
  });
}

/** Inside the clone's `.git`, so a bundle can never be committed by `git add -A`. */
const OUTGOING_BUNDLE = '.git/jig-out.bundle';

/** The bundle in it is already fetched; a leftover in the temp directory harms nothing. */
async function removeImportDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

/** Reads `git diff --name-status -z` output: a status, then a path — and the new path after the old when the status renames or copies. */
function parseChangedFiles(raw: string): ChangedFile[] {
  const changes: ChangedFile[] = [];
  const fields = raw.split('\0');
  for (let at = 0; at < fields.length;) {
    const status = fields[at++];
    if (!status) break;
    const letter = status.charAt(0);
    const path = fields[at++];
    const newPath = TWO_PATH_STATUS_LETTERS.includes(letter) ? fields[at++] : path;
    if (!path || !newPath) break;
    changes.push({ path: newPath, kind: KIND_OF_STATUS[letter] ?? 'modified' });
  }
  return changes;
}

/** The statuses git reports as `S<score>`, carrying the new path after the old one. */
const TWO_PATH_STATUS_LETTERS = ['R', 'C'];

const KIND_OF_STATUS: Record<string, ChangeKind> = {
  A: 'added',
  C: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'modified',
};

/** Leaves the operator's repository as it was; there is nothing to abort when git never started merging. */
async function abortMergeInProgress(repoRoot: string): Promise<void> {
  await openRepo(repoRoot)
    .raw(['merge', '--abort'])
    .catch(() => undefined);
}
