/** The run's worktree and branch, seen from the host. */
export interface Workspace {
  /** Commits every change in the worktree; resolves to the new commit's sha, or null when clean. */
  commitAll(message: string): Promise<string | null>;
  /** Reads a file from the operator's repository, relative to its root; undefined when absent. */
  readRepoFile(relativePath: string): Promise<string | undefined>;
  /** Throws `MergeFailed` when the base branch is not checked out, is dirty, or conflicts. */
  mergeRunBranch(): Promise<void>;
  isRunBranchMerged(): Promise<boolean>;
}
