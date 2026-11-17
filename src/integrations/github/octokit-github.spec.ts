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
    client.repos.get.mockRejectedValue({ status, message: faker.string.alphanumeric(30) });
    const result = await github.getDefaultBranch(repository);
    expect(result.isErr() && result.error._tag).toBe(tag);
    expect(client.repos.get).toHaveBeenCalledTimes(1);
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
    unwrap(await github.commentOnIssue(repository, number, input.body));
    expect(client.issues.createComment).toHaveBeenCalledWith({
      ...repository,
      issue_number: number,
      body: input.body,
    });
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
