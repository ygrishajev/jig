import type { Result } from 'better-result';

import type { RepositoryIdentity } from '../../domain/repository-identity.js';
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
   * the caller reconciles it with `findIssueComment` before posting again. A PR's number gets a
   * PR-level conversation comment, never an inline review comment.
   */
  commentOnIssue(
    repository: RepositoryIdentity,
    number: number,
    body: string,
  ): Promise<Result<string, GithubFailure>>;
  /** The URL of the issue's or PR's conversation comment carrying `marker`, if already posted. */
  findIssueComment(
    repository: RepositoryIdentity,
    number: number,
    marker: string,
  ): Promise<Result<string | undefined, GithubFailure>>;
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
