import { Octokit } from '@octokit/rest';
import { Result } from 'better-result';
import { z } from 'zod';

import { retryResult } from '../../domain/retry.js';
import { GithubNotFound, GithubRefused, GithubUnavailable } from './errors.js';
import type {
  GithubFailure,
  GithubPort,
  Issue,
  OpenPullRequest,
  PullRequest,
  RepositoryIdentity,
} from './github-port.js';

export interface GithubClient {
  issues: {
    get(
      input: RepositoryIdentity & Record<string, unknown> & { issue_number: number },
    ): Promise<{ data: { number: number; title: string; body?: string | null; html_url: string } }>;
    createComment(
      input: RepositoryIdentity & Record<string, unknown> & { issue_number: number; body: string },
    ): Promise<unknown>;
  };
  repos: {
    get(
      input: RepositoryIdentity & Record<string, unknown>,
    ): Promise<{ data: { default_branch: string } }>;
  };
  pulls: {
    list(
      input: RepositoryIdentity & Record<string, unknown> & { head: string; state: 'open' },
    ): Promise<{ data: { number: number; html_url: string }[] }>;
    create(
      input: RepositoryIdentity & OpenPullRequest & Record<string, unknown>,
    ): Promise<{ data: { number: number; html_url: string } }>;
  };
}

export class OctokitGithub implements GithubPort {
  constructor(private readonly client: GithubClient) {}

  static authenticated(token: string): OctokitGithub {
    return new OctokitGithub(new Octokit({ auth: token }).rest);
  }

  getIssue(repository: RepositoryIdentity, number: number): Promise<Result<Issue, GithubFailure>> {
    return this.call(async () => {
      const { data } = await this.client.issues.get({ ...repository, issue_number: number });
      return { number: data.number, title: data.title, body: data.body ?? '', url: data.html_url };
    });
  }

  private call<T>(operation: () => Promise<T>): Promise<Result<T, GithubFailure>> {
    return retryResult(() => Result.tryPromise({ try: operation, catch: githubFailure }), {
      retries: GITHUB_RETRIES,
      delayMs: GITHUB_RETRY_DELAY_MS,
      shouldRetry: (error) => error._tag === 'GithubUnavailable',
    });
  }

  getDefaultBranch(repository: RepositoryIdentity): Promise<Result<string, GithubFailure>> {
    return this.call(
      async () => (await this.client.repos.get({ ...repository })).data.default_branch,
    );
  }

  findOpenPullRequestByHead(
    repository: RepositoryIdentity,
    head: string,
  ): Promise<Result<PullRequest | undefined, GithubFailure>> {
    return this.call(async () => {
      const { data } = await this.client.pulls.list({
        ...repository,
        head: `${repository.owner}:${head}`,
        state: 'open',
      });
      return data[0] ? { number: data[0].number, url: data[0].html_url } : undefined;
    });
  }

  openPullRequest(
    repository: RepositoryIdentity,
    input: OpenPullRequest,
  ): Promise<Result<PullRequest, GithubFailure>> {
    return this.call(async () => {
      const { data } = await this.client.pulls.create({ ...repository, ...input });
      return { number: data.number, url: data.html_url };
    });
  }

  commentOnIssue(
    repository: RepositoryIdentity,
    number: number,
    body: string,
  ): Promise<Result<void, GithubFailure>> {
    return this.call(async () => {
      await this.client.issues.createComment({ ...repository, issue_number: number, body });
    });
  }
}

function githubFailure(cause: unknown): GithubFailure {
  const parsed = z.object({ status: z.number() }).safeParse(cause);
  const status = parsed.success ? parsed.data.status : undefined;
  if (status === 404) return new GithubNotFound({ message: 'GitHub resource was not found.' });
  if (status !== undefined && status >= 400 && status < 500)
    return new GithubRefused({ message: `GitHub refused the operation (${status}).` });
  return new GithubUnavailable({ message: 'GitHub is unavailable; try again later.' });
}

/** Short outages should not abort an unattended job, while retries remain bounded. */
const GITHUB_RETRIES = 3;

/** Back off from an unavailable API rather than immediately sending the request again. */
const GITHUB_RETRY_DELAY_MS = 1000;
