import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { presetName } from '../../../tests/support/builders.js';
import type { JigOperations } from '../../app/api.js';
import { GithubRefused } from '../../ports/github.js';
import type { FailureOutput } from '../with-error-handling.js';
import { describeIssueOutcome, registerGithubCommands } from './github.js';

describe('github implement command', () => {
  it('describes a newly opened PR with its URL', () => {
    const outcome = { kind: 'pullRequest', url: faker.internet.url(), reused: false } as const;
    expect(describeIssueOutcome(outcome)).toContain(outcome.url);
  });

  it('distinguishes a reused PR from a newly opened PR with the same URL', () => {
    const outcome = { kind: 'pullRequest', url: faker.internet.url(), reused: true } as const;
    const description = describeIssueOutcome(outcome);
    expect(description).toContain(outcome.url);
    expect(description).not.toBe(describeIssueOutcome({ ...outcome, reused: false }));
  });

  it('describes a draft PR with its URL and its findings comment URL', () => {
    const outcome = {
      kind: 'draftPullRequest',
      url: faker.internet.url(),
      reused: faker.datatype.boolean(),
      findingsUrl: faker.internet.url(),
    } as const;
    const description = describeIssueOutcome(outcome);
    expect(description).toContain(outcome.url);
    expect(description).toContain(outcome.findingsUrl);
    expect(description).not.toBe(describeIssueOutcome({ ...outcome, reused: !outcome.reused }));
    expect(description).not.toBe(
      describeIssueOutcome({ kind: 'pullRequest', url: outcome.url, reused: outcome.reused }),
    );
  });

  it.each(['completed', 'stuck', 'blocked', 'halted'] as const)(
    'describes a %s comment with its status and URL',
    (status) => {
      const outcome = { kind: 'commented', outcome: status, url: faker.internet.url() } as const;
      const description = describeIssueOutcome(outcome);
      expect(description).toContain(outcome.outcome);
      expect(description).toContain(outcome.url);
    },
  );

  it('describes a refusal with every refused path and its comment URL', () => {
    const paths = faker.helpers.uniqueArray(
      () => `.github/workflows/${faker.string.alpha(8)}.yml`,
      2,
    );
    const outcome = { kind: 'refused', paths, url: faker.internet.url() } as const;
    const description = describeIssueOutcome(outcome);
    for (const path of paths) expect(description).toContain(path);
    expect(description).toContain(outcome.url);
  });

  it('asks for the parsed issue with the config file, preset and log format it was given', async () => {
    const { run, implementIssue, output } = setup();
    const issueNumber = faker.number.int({ min: 1, max: 10_000 });
    const config = `${faker.word.noun()}.json`;
    const preset = presetName();

    const logFormat = faker.helpers.arrayElement(['pretty', 'json'] as const);

    await run([
      '--issue',
      String(issueNumber),
      '--config',
      config,
      '--preset',
      preset,
      '--log-format',
      logFormat,
    ]);

    expect(implementIssue).toHaveBeenCalledWith({
      issueNumber,
      configPath: config,
      preset: { kind: 'named', name: preset },
      logFormat,
    });
    expect(output.setExitCode).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', 'text', '1.5'])(
    'refuses invalid issue %s without asking to implement it',
    async (issue) => {
      const { run, implementIssue, output } = setup();

      await run(['--issue', issue]);

      expect(implementIssue).not.toHaveBeenCalled();
      expect(output.setExitCode).toHaveBeenCalledWith(1);
    },
  );

  it("prints the operation's failure and exits with 1", async () => {
    const failure = new GithubRefused({ message: faker.lorem.sentence() });
    const { run, output } = setup({ published: Result.err(failure) });

    await run(['--issue', '1']);

    expect(output.printError).toHaveBeenCalledWith(failure.message);
    expect(output.setExitCode).toHaveBeenCalledWith(1);
  });

  function setup({
    published = Result.ok({ kind: 'pullRequest', url: faker.internet.url(), reused: false }),
  }: { published?: Awaited<ReturnType<JigOperations['implementIssue']>> } = {}) {
    const implementIssue = vi.fn<JigOperations['implementIssue']>(async () => published);
    const output = mock<FailureOutput>();
    const program = new Command();
    registerGithubCommands(program, implementIssue, output);
    return {
      implementIssue,
      output,
      run: (args: string[]) =>
        program.parseAsync(['github', 'implement', ...args], { from: 'user' }),
    };
  }
});
