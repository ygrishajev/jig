export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/** A commit and how much it changed, so the size of each slice is on record. */
export interface CommitSummary {
  sha: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}
