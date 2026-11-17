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
import { createAppContainer } from '../../app/container.js';
import type { Invocation } from '../../cli/with-app.js';
import type { FailureOutput } from '../../cli/with-error-handling.js';
import { buildJigCli } from './cli.js';
import { GithubRefused } from './errors.js';

describe('github implement command', () => {
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
    github.failOnce('commentOnIssue', new GithubRefused({ message: faker.lorem.sentence() }));
    await run(['--issue', '1']);
    expect(output.setExitCode).toHaveBeenCalledWith(1);
    output.printError.mockClear();
    output.setExitCode.mockClear();
    invocation.cwd = await cloneOf();
    await run(['--issue', '1']);
    expect(output.printError).not.toHaveBeenCalled();
    expect(output.setExitCode).not.toHaveBeenCalled();
    expect(github.prsOpened).toBe(1);
    expect(github.commentsMade).toBe(1);
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
      createAppContainer: createApp,
      standardInput: fakeStandardInput(),
      askForPreset: async () => undefined,
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
