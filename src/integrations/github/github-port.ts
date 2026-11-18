import type { Result } from 'better-result';

import type { GithubNotFound, GithubRefused, GithubUnavailable } from './errors.js';

export interface GithubPort {
  getIssue(repository: RepositoryIdentity, number: number): Promise<Result<Issue, GithubFailure>>;
  getDefaultBranch(repository: RepositoryIdentity): Promise<Result<string, GithubFailure>>;
  findOpenPullRequestByHead(
    repository: RepositoryIdentity,
    head: string,
  ): Promise<Result<PullRequest | undefined, GithubFailure>>;
  openPullRequest(
    repository: RepositoryIdentity,
    input: OpenPullRequest,
  ): Promise<Result<PullRequest, GithubFailure>>;
  /**
   * Posts once and never retries: an unavailable response may hide a comment GitHub did post, so
   * the caller reconciles it with `findIssueComment` before posting again.
   */
  commentOnIssue(
    repository: RepositoryIdentity,
    number: number,
    body: string,
  ): Promise<Result<string, GithubFailure>>;
  /** The URL of the issue's comment whose body carries `marker`, if one was already posted. */
  findIssueComment(
    repository: RepositoryIdentity,
    number: number,
    marker: string,
  ): Promise<Result<string | undefined, GithubFailure>>;
}
export interface RepositoryIdentity {
  owner: string;
  repo: string;
}
export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
}

export type GithubFailure = GithubNotFound | GithubRefused | GithubUnavailable;
export interface PullRequest {
  number: number;
  url: string;
}
export interface OpenPullRequest {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}
