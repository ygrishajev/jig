import { faker } from '@faker-js/faker';
import { Result, TaggedError } from 'better-result';
import { describe, expect, it, vi } from 'vitest';

import { unwrap } from '../../tests/support/unwrap.js';
import { GithubSettingsInvalid } from './errors.js';
import { githubSettingsFrom } from './github-settings.js';

describe('githubSettingsFrom', () => {
  it('prefers GITHUB_TOKEN when both tokens are set', async () => {
    const token = faker.string.alphanumeric(30);
    const { settingsFrom, repositoryName } = setup();

    const settings = unwrap(
      await settingsFrom({
        GITHUB_TOKEN: token,
        GH_TOKEN: faker.string.alphanumeric(30),
        GITHUB_REPOSITORY: repositoryName,
      }),
    );

    expect(settings.token).toBe(token);
  });

  it('takes GH_TOKEN when GITHUB_TOKEN is unset', async () => {
    const token = faker.string.alphanumeric(30);
    const { settingsFrom, repositoryName } = setup();

    const settings = unwrap(
      await settingsFrom({ GH_TOKEN: token, GITHUB_REPOSITORY: repositoryName }),
    );

    expect(settings.token).toBe(token);
  });

  it.each([{}, { GITHUB_TOKEN: '' }, { GH_TOKEN: '' }])(
    'refuses %o without looking at the origin',
    async (environment) => {
      const { settingsFrom, originName } = setup();

      const result = await settingsFrom(environment);

      expect(result.isErr() && result.error).toBeInstanceOf(GithubSettingsInvalid);
      expect(originName).not.toHaveBeenCalled();
    },
  );

  it('names the repository from GITHUB_REPOSITORY without looking at the origin', async () => {
    const owner = faker.string.alpha(10);
    const repo = faker.string.alpha(10);
    const { settingsFrom, originName } = setup();

    const settings = unwrap(
      await settingsFrom({
        GITHUB_TOKEN: faker.string.alphanumeric(30),
        GITHUB_REPOSITORY: `${owner}/${repo}`,
      }),
    );

    expect(settings.repository).toEqual({ owner, repo });
    expect(originName).not.toHaveBeenCalled();
  });

  it.each(['invalid', '../x/y', ''])(
    'refuses GITHUB_REPOSITORY %j rather than falling back to the origin',
    async (name) => {
      const { settingsFrom, originName } = setup();

      const result = await settingsFrom({
        GITHUB_TOKEN: faker.string.alphanumeric(30),
        GITHUB_REPOSITORY: name,
      });

      expect(result.isErr() && result.error).toBeInstanceOf(GithubSettingsInvalid);
      expect(originName).not.toHaveBeenCalled();
    },
  );

  it('names the repository from the origin when GITHUB_REPOSITORY is unset', async () => {
    const owner = faker.string.alpha(10);
    const repo = faker.string.alpha(10);
    const { settingsFrom } = setup({ origin: Result.ok(`${owner}/${repo}`) });

    const settings = unwrap(await settingsFrom({ GITHUB_TOKEN: faker.string.alphanumeric(30) }));

    expect(settings.repository).toEqual({ owner, repo });
  });

  it('refuses an origin outside GitHub', async () => {
    const { settingsFrom } = setup({ origin: Result.ok(undefined) });

    const result = await settingsFrom({ GITHUB_TOKEN: faker.string.alphanumeric(30) });

    expect(result.isErr() && result.error).toBeInstanceOf(GithubSettingsInvalid);
  });

  it('returns the failure to read the origin as it is', async () => {
    const failure = new OriginUnreadable({ message: faker.lorem.sentence() });
    const { settingsFrom } = setup({ origin: Result.err(failure) });

    const result = await settingsFrom({ GITHUB_TOKEN: faker.string.alphanumeric(30) });

    expect(result.isErr() && result.error).toBe(failure);
  });

  function setup({
    origin = Result.ok<string | undefined, OriginUnreadable>(
      `${faker.string.alpha(10)}/${faker.string.alpha(10)}`,
    ),
  }: { origin?: Result<string | undefined, OriginUnreadable> } = {}) {
    const originName = vi.fn(async () => origin);
    return {
      originName,
      repositoryName: `${faker.string.alpha(10)}/${faker.string.alpha(10)}`,
      settingsFrom: (environment: Record<string, string | undefined>) =>
        githubSettingsFrom(environment, originName),
    };
  }
});

class OriginUnreadable extends TaggedError('OriginUnreadable')<{ message: string }> {}
