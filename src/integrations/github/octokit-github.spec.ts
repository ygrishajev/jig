import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { unwrap } from '../../../tests/support/unwrap.js';
import { type GithubClient, OctokitGithub } from './octokit-github.js';

describe('OctokitGithub', () => {
  it.each([
    [401, 'GithubRefused'],
    [403, 'GithubRefused'],
    [404, 'GithubNotFound'],
    [422, 'GithubRefused'],
  ])('maps HTTP %s to %s', async (status, tag) => {
    const { client, github, repository } = setup();
    const message = faker.lorem.sentence();
    client.repos.get.mockRejectedValue({ status, message });
    const result = await github.getDefaultBranch(repository);
    expect(result.isErr() && result.error._tag).toBe(tag);
    expect(result.isErr() && result.error.message).toContain(
      `getDefaultBranch ${repository.owner}/${repository.repo}`,
    );
    expect(result.isErr() && result.error.message).toContain(String(status));
    expect(result.isErr() && result.error.message).toContain(message);
    expect(client.repos.get).toHaveBeenCalledTimes(1);
  });

  it('reports the issue and response reason for a missing issue', async () => {
    const { client, github, repository } = setup();
    const number = faker.number.int({ min: 1 });
    const message = faker.lorem.sentence();
    client.issues.get.mockRejectedValue({ status: 404, response: { data: { message } } });
    const result = await github.getIssue(repository, number);
    expect(result.isErr() && result.error.message).toContain(
      `getIssue ${repository.owner}/${repository.repo}#${number}`,
    );
    expect(result.isErr() && result.error.message).toContain('404');
    expect(result.isErr() && result.error.message).toContain(message);
  });

  it('reports the head and base when GitHub refuses publication', async () => {
    const { client, github, repository } = setup();
    const input = {
      head: faker.git.branch(),
      base: faker.git.branch(),
      title: faker.lorem.sentence(),
      body: faker.lorem.paragraph(),
      draft: false,
    };
    const message = `No commits between ${input.base} and ${input.head}`;
    client.pulls.create.mockRejectedValue({ status: 422, message });
    const result = await github.openPullRequest(repository, input);
    expect(result.isErr() && result.error.message).toContain(
      `openPullRequest ${repository.owner}/${repository.repo}: ${input.head} -> ${input.base}`,
    );
    expect(result.isErr() && result.error.message).toContain('422');
    expect(result.isErr() && result.error.message).toContain(message);
  });

  it.each([503, 0, undefined])('retries an unavailable response with status %s', async (status) => {
    const { client, github, repository } = setup();
    const branch = faker.string.alpha(10);
    client.repos.get
      .mockRejectedValueOnce({ status })
      .mockResolvedValue({ data: { default_branch: branch } });
    expect(unwrap(await github.getDefaultBranch(repository))).toBe(branch);
    expect(client.repos.get).toHaveBeenCalledTimes(2);
  });

  it('posts a comment once when its response is lost, so a marker lookup can reconcile it', async () => {
    const { client, github, repository } = setup();
    const number = faker.number.int({ min: 1 });
    const body = faker.lorem.paragraph();
    client.issues.createComment
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValue({ data: { html_url: faker.internet.url() } });

    const result = await github.commentOnIssue(repository, number, body);

    expect(result.isErr() && result.error._tag).toBe('GithubUnavailable');
    expect(client.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it('translates issues, head searches, PR creation and comments', async () => {
    const { client, github, repository } = setup();
    const number = faker.number.int({ min: 1 });
    const title = faker.lorem.sentence();
    const url = faker.internet.url();
    client.issues.get.mockResolvedValue({ data: { number, title, body: null, html_url: url } });
    expect(unwrap(await github.getIssue(repository, number))).toEqual({
      number,
      title,
      body: '',
      url,
    });
    const head = faker.git.branch();
    client.pulls.list
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [{ number, html_url: url }] });
    expect(unwrap(await github.findOpenPullRequestByHead(repository, head))).toBeUndefined();
    expect(unwrap(await github.findOpenPullRequestByHead(repository, head))).toEqual({
      number,
      url,
    });
    expect(client.pulls.list).toHaveBeenCalledWith({
      ...repository,
      head: `${repository.owner}:${head}`,
      state: 'open',
    });
    const input = {
      head,
      base: faker.git.branch(),
      title,
      body: faker.lorem.paragraph(),
      draft: true,
    };
    client.pulls.create.mockResolvedValue({ data: { number, html_url: url } });
    expect(unwrap(await github.openPullRequest(repository, input))).toEqual({ number, url });
    expect(client.pulls.create).toHaveBeenCalledWith({ ...repository, ...input });
    client.issues.createComment.mockResolvedValue({ data: { html_url: url } });
    expect(unwrap(await github.commentOnIssue(repository, number, input.body))).toBe(url);
    expect(client.issues.createComment).toHaveBeenCalledWith({
      ...repository,
      issue_number: number,
      body: input.body,
    });
  });

  it('finds a marked comment on a later page and stops at the last page without one', async () => {
    const { client, github, repository } = setup();
    const number = faker.number.int({ min: 1 });
    const marker = `<!-- ${faker.string.uuid()} -->`;
    const url = faker.internet.url();
    const unmarked = (count: number) =>
      Array.from({ length: count }, () => ({
        body: faker.lorem.sentence(),
        html_url: faker.internet.url(),
      }));
    client.issues.listComments
      .mockResolvedValueOnce({ data: unmarked(100) })
      .mockResolvedValueOnce({
        data: [...unmarked(3), { body: `${faker.lorem.sentence()}\n${marker}`, html_url: url }],
      })
      .mockResolvedValueOnce({ data: [{ body: null, html_url: faker.internet.url() }] });

    expect(unwrap(await github.findIssueComment(repository, number, marker))).toBe(url);
    expect(client.issues.listComments).toHaveBeenLastCalledWith({
      ...repository,
      issue_number: number,
      per_page: 100,
      page: 2,
    });
    expect(unwrap(await github.findIssueComment(repository, number, marker))).toBeUndefined();
    expect(client.issues.listComments).toHaveBeenCalledTimes(3);
  });

  function setup() {
    const client = {
      issues: mock<GithubClient['issues']>(),
      repos: mock<GithubClient['repos']>(),
      pulls: mock<GithubClient['pulls']>(),
    };
    return {
      client,
      github: new OctokitGithub(client),
      repository: { owner: faker.string.alpha(10), repo: faker.string.alpha(10) },
    };
  }
});
