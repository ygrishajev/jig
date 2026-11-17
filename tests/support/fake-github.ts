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

export function anIssue({
  number = faker.number.int({ min: 1, max: 10000 }),
  title = faker.lorem.sentence(),
  body = faker.lorem.paragraph(),
  url = faker.internet.url(),
}: Partial<Issue> = {}): Issue {
  return { number, title, body, url };
}

export class FakeGithub implements GithubPort {
  readonly issues = new Map<number, Issue>();
  readonly pullRequests = new Map<string, PullRequest & OpenPullRequest>();
  readonly comments: { number: number; body: string }[] = [];
  prsOpened = 0;
  commentsMade = 0;
  defaultBranch = 'main';
  private readonly failures = new Map<keyof GithubPort, GithubFailure>();

  failOnce(operation: keyof GithubPort, failure: GithubFailure): void {
    this.failures.set(operation, failure);
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
    return failure ? Result.err(failure) : Result.ok(work());
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
        number: faker.number.int({ min: 1, max: 10000 }),
        url: faker.internet.url(),
      };
      this.pullRequests.set(input.head, pr);
      return pr;
    });
  }

  async commentOnIssue(_repository: RepositoryIdentity, number: number, body: string) {
    return this.perform('commentOnIssue', () => {
      this.commentsMade++;
      this.comments.push({ number, body });
      return faker.internet.url();
    });
  }
}
