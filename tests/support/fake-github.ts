import { faker } from '@faker-js/faker';
import { Result } from 'better-result';

import { GithubNotFound } from '../../src/integrations/github/errors.js';
import type {
  GithubFailure,
  GithubPort,
  Issue,
  OpenPullRequest,
  PullRequest,
  RepositoryIdentity,
} from '../../src/integrations/github/github-port.js';

/** Issues and PRs share GitHub's numbering, so the fake keeps their numbers apart. */
const HIGHEST_ISSUE_NUMBER = 10000;

export function anIssue({
  number = faker.number.int({ min: 1, max: HIGHEST_ISSUE_NUMBER }),
  title = faker.lorem.sentence(),
  body = faker.lorem.paragraph(),
  url = faker.internet.url(),
}: Partial<Issue> = {}): Issue {
  return { number, title, body, url };
}

export class FakeGithub implements GithubPort {
  readonly issues = new Map<number, Issue>();
  readonly pullRequests = new Map<string, PullRequest & OpenPullRequest>();
  readonly comments: { number: number; body: string; url: string }[] = [];
  prsOpened = 0;
  commentsMade = 0;
  defaultBranch = 'main';
  private readonly failures = new Map<keyof GithubPort, GithubFailure>();
  private readonly failuresAfterEffect = new Map<keyof GithubPort, GithubFailure>();

  failOnce(operation: keyof GithubPort, failure: GithubFailure): void {
    this.failures.set(operation, failure);
  }

  /** The next `operation` takes effect on GitHub but reports `failure`, as a lost response would. */
  failOnceAfterEffect(operation: keyof GithubPort, failure: GithubFailure): void {
    this.failuresAfterEffect.set(operation, failure);
  }

  async getIssue(_repository: RepositoryIdentity, number: number) {
    const result = this.perform('getIssue', () => this.issues.get(number));
    if (result.isErr()) return Result.err(result.error);
    return result.value
      ? Result.ok(result.value)
      : Result.err(new GithubNotFound({ message: `Issue ${number} was not found.` }));
  }

  private perform<T>(operation: keyof GithubPort, work: () => T): Result<T, GithubFailure> {
    const failure = this.failures.get(operation);
    this.failures.delete(operation);
    if (failure) return Result.err(failure);
    const value = work();
    const lost = this.failuresAfterEffect.get(operation);
    this.failuresAfterEffect.delete(operation);
    return lost ? Result.err(lost) : Result.ok(value);
  }

  async getDefaultBranch(_repository: RepositoryIdentity) {
    return this.perform('getDefaultBranch', () => this.defaultBranch);
  }

  async findOpenPullRequestByHead(_repository: RepositoryIdentity, head: string) {
    return this.perform('findOpenPullRequestByHead', () => this.pullRequests.get(head));
  }

  async openPullRequest(_repository: RepositoryIdentity, input: OpenPullRequest) {
    return this.perform('openPullRequest', () => {
      this.prsOpened++;
      const pr = {
        ...input,
        number: faker.number.int({ min: HIGHEST_ISSUE_NUMBER + 1, max: 2 * HIGHEST_ISSUE_NUMBER }),
        url: faker.internet.url(),
      };
      this.pullRequests.set(input.head, pr);
      return pr;
    });
  }

  async commentOnIssue(_repository: RepositoryIdentity, number: number, body: string) {
    return this.perform('commentOnIssue', () => {
      this.commentsMade++;
      const url = faker.internet.url();
      this.comments.push({ number, body, url });
      return url;
    });
  }

  async findIssueComment(_repository: RepositoryIdentity, number: number, marker: string) {
    return this.perform(
      'findIssueComment',
      () =>
        this.comments.find((comment) => comment.number === number && comment.body.includes(marker))
          ?.url,
    );
  }
}
