import type { Result } from 'better-result';

import type {
  CommitImportRefused,
  CommitRejected,
  GitCommandFailed,
  LocalStateUnwritable,
  MergeFailed,
  RemoteUnavailable,
  SandboxUnavailable,
} from '../domain/errors.js';
import type { ChangedFile } from '../domain/protected-paths.js';
import type { CommitSummary } from '../domain/usage.js';
import type { WorkFacts } from '../domain/work-facts.js';

/** The run's branch, seen from the host, and how the sandbox's work reaches it. */
export interface Workspace {
  /**
   * Commits whatever is uncommitted in the sandbox, through the repository's own commit hooks, then brings its commits onto the run branch.
   * Work after `approved` may be replaced; `approved` itself must stay in the history.
   */
  saveWork(message: string, options: { approved: string }): Promise<Result<void, SaveWorkFailure>>;
  /** The commit at the tip of the run branch. */
  headCommit(): Promise<Result<string, GitCommandFailed>>;
  /** The base branch commit the run branch was cut from. */
  forkPoint(): Promise<Result<string, GitCommandFailed>>;
  /** HEAD, with the size of everything committed after `since`. */
  summariseCommitsSince(since: string): Promise<Result<CommitSummary, GitCommandFailed>>;
  /** The files the run branch changed since `start`, and how each changed. */
  changedFilesSince(start: string): Promise<Result<ChangedFile[], GitCommandFailed>>;
  /** Where the run's work stands right now: the host's run branch and the sandbox clone beside it. */
  collectFacts(): Promise<Result<WorkFacts, GitCommandFailed | SandboxUnavailable>>;
  /** Reads a file from the operator's repository, relative to its root; undefined when absent. */
  readRepoFile(relativePath: string): Promise<string | undefined>;
  /**
   * Fails with `MergeFailed` when the branch's content is not what `approved` holds, the base
   * branch is not checked out, is dirty, or conflicts.
   */
  mergeRunBranch(options: { approved: string | undefined }): Promise<Result<void, MergeFailed>>;
  /** Whether the run's changes are in the base, locally or on its remote, by any kind of merge. */
  isRunBranchMerged(): Promise<Result<boolean, GitCommandFailed | RemoteUnavailable>>;
}

/** Why the sandbox's work did not reach the run branch. */
export type SaveWorkFailure =
  | GitCommandFailed
  | CommitImportRefused
  | CommitRejected
  | SandboxUnavailable
  | LocalStateUnwritable;
