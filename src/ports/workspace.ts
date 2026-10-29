import type { CommitSummary } from '../domain/usage.js';

/** The run's worktree and branch, seen from the host. */
export interface Workspace {
  /** Commits every uncommitted change in the worktree; does nothing when there is none. */
  commitAll(message: string): Promise<void>;
  /** The commit the run branch's worktree has checked out. */
  headCommit(): Promise<string>;
  /** The base branch commit the run branch was cut from. */
  forkPoint(): Promise<string>;
  /** HEAD, with the size of everything committed after `since`. */
  summariseCommitsSince(since: string): Promise<CommitSummary>;
  /** Reads a file from the operator's repository, relative to its root; undefined when absent. */
  readRepoFile(relativePath: string): Promise<string | undefined>;
  /** Throws `MergeFailed` when the base branch is not checked out, is dirty, or conflicts. */
  mergeRunBranch(): Promise<void>;
  /** Whether the run's changes are in the base, locally or on its remote, by any kind of merge. */
  isRunBranchMerged(): Promise<boolean>;
}
