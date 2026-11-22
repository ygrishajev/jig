import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { Result } from 'better-result';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { scriptWholeRun } from '../../../tests/support/agent-scripts.js';
import { everyStepOn } from '../../../tests/support/builders.js';
import { anIssue, FakeGithub } from '../../../tests/support/fake-github.js';
import { FakeAgentSession, fakeStandardInput } from '../../../tests/support/fakes.js';
import { openRunWorktree, sandboxCloneOf } from '../../../tests/support/open-run-worktree.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { presetFilesOnDisk } from '../../adapters/config/preset-files.js';
import { configFileSource } from '../../adapters/filesystem/config-source.js';
import { createAppContainer } from '../../app/container.js';
import type { Invocation } from '../../cli/with-app.js';
import type { FailureOutput } from '../../cli/with-error-handling.js';
import { buildJigCli } from './cli.js';
import { describeIssueOutcome } from './command.js';
import { GithubRefused } from './errors.js';

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

  it('refuses a missing token before opening the app', async () => {
    const { run, output, createApp } = await setup();
    await run(['--issue', '1']);
    expect(output.setExitCode).toHaveBeenCalledWith(1);
    expect(createApp).not.toHaveBeenCalled();
  });

  it('refuses an empty token before opening the app', async () => {
    const { run, output, createApp } = await setup({ environment: { GITHUB_TOKEN: '' } });
    await run(['--issue', '1']);
    expect(output.setExitCode).toHaveBeenCalledWith(1);
    expect(createApp).not.toHaveBeenCalled();
  });

  it('prefers GITHUB_TOKEN when both tokens are configured', async () => {
    const token = faker.string.alphanumeric(30);
    const { run, githubFor, github } = await setup({
      environment: {
        GITHUB_TOKEN: token,
        GH_TOKEN: faker.string.alphanumeric(30),
        GITHUB_REPOSITORY: `${faker.string.alpha(8)}/${faker.string.alpha(8)}`,
      },
    });
    github.failOnce('getDefaultBranch', new GithubRefused({ message: faker.lorem.sentence() }));
    await run(['--issue', '1']);
    expect(githubFor).toHaveBeenCalledWith(token);
  });

  it.each(['0', '-1', 'text', '1.5'])(
    'refuses invalid issue %s before opening the app',
    async (issue) => {
      const { run, output, createApp } = await setup();
      await run(['--issue', issue]);
      expect(output.setExitCode).toHaveBeenCalledWith(1);
      expect(createApp).not.toHaveBeenCalled();
    },
  );

  it.each(['GITHUB_TOKEN', 'GH_TOKEN'])(
    'passes %s privately and reports a GitHub refusal plainly',
    async (variable) => {
      const token = faker.string.alphanumeric(30);
      const { run, output, githubFor, github } = await setup({
        environment: {
          [variable]: token,
          GITHUB_REPOSITORY: `${faker.string.alpha(8)}/${faker.string.alpha(8)}`,
        },
      });
      const message = faker.lorem.sentence();
      github.failOnce('getDefaultBranch', new GithubRefused({ message }));
      await run(['--issue', '1']);
      expect(githubFor).toHaveBeenCalledWith(token);
      expect(output.printError).toHaveBeenCalledWith(message);
      expect(output.setExitCode).toHaveBeenCalledWith(1);
    },
  );

  it('refuses a malformed repository before opening the app', async () => {
    const { run, output, createApp } = await setup({
      environment: { GITHUB_TOKEN: faker.string.alphanumeric(30), GITHUB_REPOSITORY: 'invalid' },
    });
    await run(['--issue', '1']);
    expect(output.setExitCode).toHaveBeenCalledWith(1);
    expect(createApp).not.toHaveBeenCalled();
  });

  it('runs from the composing CLI and resumes publication from another clone', async () => {
    const { run, output, github, invocation, cloneOf, sessionsOpened } = await setup({
      environment: {
        GITHUB_TOKEN: faker.string.alphanumeric(30),
        GITHUB_REPOSITORY: `${faker.string.alpha(8)}/${faker.string.alpha(8)}`,
        ANTHROPIC_API_KEY: faker.string.alphanumeric(30),
      },
    });
    github.failOnce('openPullRequest', new GithubRefused({ message: faker.lorem.sentence() }));
    await run(['--issue', '1']);
    expect(output.setExitCode).toHaveBeenCalledWith(1);
    output.printError.mockClear();
    output.setExitCode.mockClear();
    invocation.cwd = await cloneOf();
    await run(['--issue', '1']);
    expect(output.printError).not.toHaveBeenCalled();
    expect(output.setExitCode).not.toHaveBeenCalled();
    expect(github.prsOpened).toBe(1);
    expect(github.commentsMade).toBe(0);
    expect(sessionsOpened()).toBe(1);
  });

  async function setup({ environment = {} }: { environment?: NodeJS.ProcessEnv } = {}) {
    const remote = await createRemote();
    const cwd = await remote.cloneOf();
    const output = mock<FailureOutput>();
    const github = new FakeGithub();
    github.issues.set(1, anIssue({ number: 1 }));
    const githubFor = vi.fn(() => github);
    let sessions = 0;
    const createApp = vi.fn((input: Parameters<typeof createAppContainer>[0]) => {
      const app = createAppContainer({ ...input, logLevel: 'silent' });
      app.register({
        config: asValue({
          ...input.config,
          ...everyStepOn(),
          sandboxImage: faker.string.alpha(10),
        }),
        openSession: asValue(
          async ({ run, events }: Parameters<typeof app.cradle.openSession>[0]) => {
            sessions++;
            await openRunWorktree({ repoRoot: input.repoRoot, ...run });
            const agent = new FakeAgentSession(
              sandboxCloneOf(input.repoRoot, run.runId),
              undefined,
              path.join(input.repoRoot, '.jig', run.runId, 'workspace'),
            );
            scriptWholeRun(agent);
            return Result.ok(agent.reportUsageTo(events, run.runId));
          },
        ),
      });
      return app;
    });
    const invocation: Invocation = {
      cwd,
      environment,
      fallbackHomeDirectory: faker.system.directoryPath(),
      createAppContainer: createApp,
      configSourceAt: configFileSource,
      standardInput: fakeStandardInput(),
      askForPreset: async () => undefined,
      presetFiles: presetFilesOnDisk(),
    };
    return {
      output,
      invocation,
      cloneOf: remote.cloneOf,
      sessionsOpened: () => sessions,
      createApp,
      githubFor,
      github,
      run: (args: string[]) =>
        buildJigCli({ invocation, failureOutput: output }, githubFor).parseAsync(
          ['github', 'implement', ...args],
          { from: 'user' },
        ),
    };
  }
});
