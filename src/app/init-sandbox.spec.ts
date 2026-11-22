import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { codexLogin, everyStepOn } from '../../tests/support/builders.js';
import { FakeAgentSession } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { readConfigFile } from '../adapters/config/config-file.js';
import { TOOLCHAIN_END, TOOLCHAIN_START } from '../adapters/sandbox-image/image-recipe.js';
import type { OpenSessionInput } from '../adapters/sandcastle/open-session.js';
import type { SessionOpenFailure } from '../adapters/sandcastle/sandcastle-session.js';
import type { EnteredCredential } from '../adapters/terminal/ask-for-credential.js';
import type { AgentChoice } from '../config/agent-policy.js';
import { parseEnvironment } from '../config/environment.js';
import { configFileFor } from '../config/load-config.js';
import type { AgentRole } from '../domain/agent-role.js';
import { ConfigInvalid, SandboxUnavailable, SetupCommandFailed } from '../domain/errors.js';
import type { ExecResult } from '../ports/agent-session.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import { createAppContainer } from './container.js';
import { initSandbox } from './init-sandbox.js';

describe('initSandbox', () => {
  it('writes the sandbox Dockerfile, its gitignore and a starter config', async () => {
    const { init, file } = await setup({});

    await init({ useAgent: false });

    expect(await file('.sandcastle/Dockerfile')).toContain(TOOLCHAIN_START);
    expect(await file('.sandcastle/.gitignore')).toContain('worktrees/');
    expect(JSON.parse(await file('jig.config.json'))).toEqual({});
  });

  it('sets the chosen agent on every step and carries on with the planner', async () => {
    const agentChoice = { provider: 'codex', model: faker.word.noun() } as const;
    const { init, file, agent } = await setup({
      answer: agentChoice,
      proposals: [toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
    });

    expect(await init({ useAgent: true })).toEqual({ status: 'verified', attempts: 1 });
    expect(JSON.parse(await file('jig.config.json'))).toMatchObject(everyStepOn(agentChoice));
    expect(agent.calls).toHaveLength(1);
  });

  it('sets the chosen agent only on steps without one', async () => {
    const reviewer = { provider: 'opencode', model: `openrouter/${faker.word.noun()}` } as const;
    const answer = { provider: 'codex', model: faker.word.noun() } as const;
    const { init, file, write } = await setup({
      answer,
      proposals: [toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
    });
    await write('jig.config.json', JSON.stringify({ reviewer }));

    await init({ useAgent: true });

    expect(JSON.parse(await file('jig.config.json'))).toMatchObject({
      ...everyStepOn(answer),
      reviewer,
    });
  });

  it('asks nothing when every step already has an agent', async () => {
    const { init, asked } = await setup({
      configured: true,
      proposals: [toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
    });

    await init({ useAgent: true });

    expect(asked()).toBe(0);
  });

  it('stops with an instruction, building nothing, when no agent is chosen', async () => {
    const { init, agent, images, file } = await setup({});

    const result = await init({ useAgent: true });

    expect(result.status).toBe('needs-agents');
    expect(result.status === 'needs-agents' && result.instruction).toContain('planner');
    expect(agent.calls).toHaveLength(0);
    expect(images.build).not.toHaveBeenCalled();
    expect(JSON.parse(await file('jig.config.json'))).toEqual({});
  });

  it('does not ask for an agent with --no-agent', async () => {
    const { init, asked } = await setup({ answer: { provider: 'claude' } });

    expect((await init({ useAgent: false })).status).toBe('needs-agents');
    expect(asked()).toBe(0);
  });

  it('reports the starter files as written when agents are set but nothing can be checked', async () => {
    const { init } = await setup({ configured: true });

    expect(await init({ useAgent: false })).toEqual({ status: 'written' });
  });

  it('stops before building anything when a credential is missing and none is entered', async () => {
    const { initResult, images, agent } = await setup({
      configured: true,
      environment: {},
      proposals: [toolchainProposal()],
    });

    const result = await initResult({ useAgent: true });

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(images.build).not.toHaveBeenCalled();
    expect(agent.calls).toHaveLength(0);
  });

  it('carries on with a credential entered at the prompt, saving it when asked to', async () => {
    const value = faker.string.alphanumeric(20);
    const { init, file } = await setup({
      configured: true,
      environment: {},
      credential: { name: 'ANTHROPIC_API_KEY', value, save: true },
      proposals: [toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
    });

    expect(await init({ useAgent: true })).toEqual({ status: 'verified', attempts: 1 });
    expect(await file('.jig/.env')).toContain(value);
  });

  it('keeps a credential out of any file unless told to save it', async () => {
    const { init, exists } = await setup({
      configured: true,
      environment: {},
      credential: { name: 'ANTHROPIC_API_KEY', value: faker.string.alphanumeric(20), save: false },
      proposals: [toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
    });

    expect(await init({ useAgent: true })).toEqual({ status: 'verified', attempts: 1 });
    expect(exists('.jig/.env')).toBe(false);
  });

  it('keeps a Dockerfile and config the repository already has', async () => {
    const dockerfile = `FROM ${faker.word.noun()}`;
    const config = { ...everyStepOn(), verifyCommand: `npm run ${faker.word.verb()}` };
    const { init, file, write } = await setup({ exec: () => ({ exitCode: 0, output: '' }) });
    await write('.sandcastle/Dockerfile', dockerfile);
    await write('jig.config.json', JSON.stringify(config));

    await init({ useAgent: false });

    expect(await file('.sandcastle/Dockerfile')).toBe(dockerfile);
    expect(JSON.parse(await file('jig.config.json'))).toEqual(config);
  });

  it('stops a catch-all gitignore from hiding the Dockerfile', async () => {
    const { init, file, write } = await setup({});
    await write('.sandcastle/.gitignore', '*\n');

    await init({ useAgent: false });

    expect((await file('.sandcastle/.gitignore')).split('\n')).not.toContain('*');
  });

  it.each(['.sandcastle/.gitignore', '.sandcastle/Dockerfile'])(
    'refuses to write through %s when it is a symbolic link',
    async (link) => {
      const { initResult, write, linkTo } = await setup({});
      await write('.sandcastle/keep', '');
      const outside = path.join(await tempDirectory(), faker.string.uuid());
      const original = `${faker.lorem.word()}\n*\n`;
      await writeFile(outside, original);
      await linkTo(outside, link);

      const refusal = await initResult({ useAgent: false });

      expect(await readFile(outside, 'utf-8')).toBe(original);
      expect(refusal.isErr() && refusal.error).toBeInstanceOf(ConfigInvalid);
    },
  );

  it.each(['.sandcastle/Dockerfile', 'jig.config.json'])(
    'creates no file through %s when it is a link to nothing yet',
    async (link) => {
      const { initResult, write, linkTo } = await setup({});
      await write('.sandcastle/keep', '');
      const outside = path.join(await tempDirectory(), faker.string.uuid());
      await linkTo(outside, link);

      const refusal = await initResult({ useAgent: false });

      expect(existsSync(outside)).toBe(false);
      expect(refusal.isErr() && refusal.error).toBeInstanceOf(ConfigInvalid);
    },
  );

  it('refuses to write through a linked .sandcastle directory', async () => {
    const { initResult, linkTo } = await setup({});
    const outside = await tempDirectory();
    await linkTo(outside, '.sandcastle');

    const refusal = await initResult({ useAgent: false });

    expect(refusal.isErr() && refusal.error).toBeInstanceOf(ConfigInvalid);
    expect(await readdir(outside)).toEqual([]);
  });

  it("writes the planner's toolchain and commands once they pass in the sandbox", async () => {
    const proposal = toolchainProposal();
    const { init, file, agent } = await setup({
      configured: true,
      proposals: [proposal],
      exec: () => ({ exitCode: 0, output: '' }),
    });

    expect(await init({ useAgent: true })).toEqual({ status: 'verified', attempts: 1 });
    expect(await file('.sandcastle/Dockerfile')).toContain(
      `${TOOLCHAIN_START}\n${proposal.toolchain}\n${TOOLCHAIN_END}`,
    );
    expect(JSON.parse(await file('jig.config.json'))).toEqual({
      ...everyStepOn(),
      setupCommand: proposal.setupCommand,
      verifyCommand: proposal.verifyCommand,
    });
    expect(agent.commands).toEqual([proposal.verifyCommand]);
  });

  it('hands a failing check back to the planner and accepts the corrected toolchain', async () => {
    const failure = faker.lorem.sentence();
    const results: ExecResult[] = [{ exitCode: 1, output: failure }];
    const { init, agent } = await setup({
      configured: true,
      proposals: [toolchainProposal(), toolchainProposal()],
      exec: () => results.shift() ?? { exitCode: 0, output: '' },
    });

    expect(await init({ useAgent: true })).toEqual({ status: 'verified', attempts: 2 });
    expect(agent.calls[1].prompt).toContain(failure);
  });

  it('gives up after three attempts and reports the last failure', async () => {
    const failure = faker.lorem.sentence();
    const { init } = await setup({
      configured: true,
      proposals: [toolchainProposal(), toolchainProposal(), toolchainProposal()],
      exec: () => ({ exitCode: 2, output: failure }),
    });

    const result = await init({ useAgent: true });

    expect(result).toMatchObject({ status: 'failed', attempts: 3 });
    expect(result.status === 'failed' && result.failure).toContain(failure);
  });

  it('hands a failing setup command back to the planner', async () => {
    const failure = new SetupCommandFailed({
      message: faker.lorem.sentence(),
      output: faker.lorem.sentence(),
    });
    const { init, agent } = await setup({
      configured: true,
      proposals: [toolchainProposal(), toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
      checkSandboxFailures: [failure],
    });

    expect(await init({ useAgent: true })).toEqual({ status: 'verified', attempts: 2 });
    expect(agent.calls[1].prompt).toContain(failure.message);
  });

  it.each([
    [
      'a sandbox that would not start',
      () => new SandboxUnavailable({ message: faker.lorem.sentence() }),
    ],
    ['missing credentials', () => new ConfigInvalid({ message: faker.lorem.sentence() })],
  ])('stops on %s instead of spending the planner on it', async (_case, failure) => {
    const error = failure();
    const { initResult, agent } = await setup({
      configured: true,
      proposals: [toolchainProposal(), toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
      checkSandboxFailures: [error],
    });

    const result = await initResult({ useAgent: true });

    expect(result.isErr() && result.error).toBe(error);
    expect(agent.calls).toHaveLength(1);
  });

  it('stops before checking a toolchain it could not save to the config', async () => {
    const failure = new ConfigInvalid({ message: faker.lorem.sentence() });
    const { initResult, agent } = await setup({
      configured: true,
      proposals: [toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
      configUpdateFailure: failure,
    });

    const result = await initResult({ useAgent: true });

    expect(result.isErr() && result.error).toBe(failure);
    expect(agent.commands).toEqual([]);
  });

  async function setup(input: {
    configured?: boolean;
    configUpdateFailure?: ConfigInvalid;
    answer?: AgentChoice;
    environment?: NodeJS.ProcessEnv;
    credential?: EnteredCredential;
    proposals?: ReturnType<typeof toolchainProposal>[];
    exec?: (command: string) => ExecResult;
    checkSandboxFailures?: SessionOpenFailure[];
  }) {
    const repo = await createTempRepo();
    const codexHome = await tempDirectory();
    await writeFile(path.join(codexHome, 'auth.json'), codexLogin());
    if (input.configured) {
      await writeFile(path.join(repo.dir, 'jig.config.json'), JSON.stringify(everyStepOn()));
    }
    const agent = new FakeAgentSession(repo.dir, input.exec);
    for (const proposal of input.proposals ?? []) agent.script('planner', { output: proposal });

    const checkSandboxFailures = [...(input.checkSandboxFailures ?? [])];
    const app = createAppContainer({
      repoRoot: repo.dir,
      configFile: configFileFor(repo.dir),
      logFormat: 'json',
      logLevel: 'silent',
      environment: unwrap(
        parseEnvironment(
          input.environment ?? {
            ANTHROPIC_API_KEY: faker.string.alphanumeric(20),
            JIG_CODEX_AUTH_DIR: codexHome,
            OPENROUTER_API_KEY: faker.string.alphanumeric(20),
          },
          faker.system.directoryPath(),
        ),
      ),
      config: unwrap(readConfigFile(configFileFor(repo.dir))),
    });
    const images = mock<SandboxImages>({
      labels: vi.fn().mockResolvedValue(Result.ok(undefined)),
      build: vi.fn().mockResolvedValue(Result.ok()),
    });
    let questions = 0;
    app.register({
      images: asValue(images),
      askForCredential: asValue(async () => input.credential),
      askForAgents: asValue(async (roles: AgentRole[]) => {
        questions++;
        const { answer } = input;
        return answer && Object.fromEntries(roles.map((role) => [role, answer]));
      }),
      latestVersions: asValue(async () => ({})),
      ...(input.configUpdateFailure && {
        updateConfig: asValue(async () => Result.err(input.configUpdateFailure)),
      }),
      openSession: asValue(async ({ setupCommand }: OpenSessionInput) => {
        const failure = setupCommand === null ? undefined : checkSandboxFailures.shift();
        if (failure) return Result.err(failure);
        return Result.ok(agent);
      }),
    });
    const initResult = (options: { useAgent: boolean }) => initSandbox(app, options);
    const init = async (options: { useAgent: boolean }) => (await initResult(options)).unwrap();
    const file = (relativePath: string) => readFile(path.join(repo.dir, relativePath), 'utf-8');
    const write = async (relativePath: string, contents: string) => {
      const target = path.join(repo.dir, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    };
    const linkTo = (target: string, relativePath: string) =>
      symlink(target, path.join(repo.dir, relativePath));
    return {
      init,
      initResult,
      file,
      write,
      linkTo,
      agent,
      images,
      asked: () => questions,
      exists: (relativePath: string) => existsSync(path.join(repo.dir, relativePath)),
    };
  }
});

function toolchainProposal() {
  return {
    toolchain: `RUN apt-get update && apt-get install -y ${faker.word.noun()}`,
    setupCommand: `npm ${faker.word.verb()}`,
    verifyCommand: `npm run ${faker.word.verb()}`,
  };
}
