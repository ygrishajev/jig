export interface MergeStrategy {
  merge(repoRoot: string, branchName: string, baseBranch: string): Promise<void>;
}
