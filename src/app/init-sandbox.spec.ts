import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { codexLogin, everyStepOn } from '../../tests/support/builders.js';
import { FakeAgentSession } from '../../tests/support/fakes.js';
import {
  localSandboxRuntime,
  operationContextIn,
  realRepositorySources,
} from '../../tests/support/repository-sources.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { configDestination, configFileSource } from '../adapters/filesystem/config-source.js';
import { TOOLCHAIN_END, TOOLCHAIN_START } from '../adapters/sandbox-image/image-recipe.js';
import type { SessionOpenFailure } from '../adapters/sandcastle/sandcastle-session.js';
import type { AgentChoice, EnteredCredential } from '../config/agent-policy.js';
import { ConfigUnwritable } from '../config/config-source.js';
import { ConfigInvalid } from '../config/errors.js';
import type { AgentRole } from '../domain/agent-role.js';
import { runBranchFor, type RunIdentity } from '../domain/run-state.js';
import {
  type ExecResult,
  SandboxCredentialsInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
} from '../ports/agent-session.js';
import { RepositoryInvalid } from '../ports/git-failures.js';
import { LocalPreparationFailed } from '../ports/local-state.js';
import type { OperationLog } from '../ports/observability.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import { type InitInput, initRepository, type RuntimeRequest } from './api.js';

describe('initRepository', () => {
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

    expect(result.isErr() && result.error).toBeInstanceOf(SandboxCredentialsInvalid);
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
      expect(refusal.isErr() && refusal.error).toBeInstanceOf(LocalPreparationFailed);
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
      expect(refusal.isErr() && refusal.error).toBeInstanceOf(LocalPreparationFailed);
    },
  );

  it('refuses to write through a linked .sandcastle directory', async () => {
    const { initResult, linkTo } = await setup({});
    const outside = await tempDirectory();
    await linkTo(outside, '.sandcastle');

    const refusal = await initResult({ useAgent: false });

    expect(refusal.isErr() && refusal.error).toBeInstanceOf(LocalPreparationFailed);
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
    [
      'missing credentials',
      () => new SandboxCredentialsInvalid({ message: faker.lorem.sentence() }),
    ],
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
    const failure = new ConfigUnwritable({
      location: faker.system.filePath(),
      detail: faker.lorem.sentence(),
    });
    const { initResult, agent } = await setup({
      configured: true,
      proposals: [toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
      configWriteFailure: failure,
    });

    const result = await initResult({ useAgent: true });

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(result.isErr() && result.error.message).toBe(
      `Cannot read or write ${failure.location}: ${failure.detail}`,
    );
    expect(agent.commands).toEqual([]);
  });

  it('starts, reads and updates the config the operator chose instead of the repository one', async () => {
    const customConfig = path.join(faker.word.noun(), `${faker.word.noun()}.json`);
    const answer = { provider: 'codex', model: faker.word.noun() } as const;
    const proposal = toolchainProposal();
    const { init, file, exists, write } = await setup({
      customConfig,
      answer,
      proposals: [proposal],
      exec: () => ({ exitCode: 0, output: '' }),
    });
    await write(customConfig, '{}');

    expect(await init({ useAgent: true })).toEqual({ status: 'verified', attempts: 1 });
    expect(JSON.parse(await file(customConfig))).toEqual({
      ...everyStepOn(answer),
      setupCommand: proposal.setupCommand,
      verifyCommand: proposal.verifyCommand,
    });
    expect(exists('jig.config.json')).toBe(false);
  });

  it('writes neither starter file when the config is a link', async () => {
    const { initResult, write, linkTo, exists } = await setup({});
    await write('.sandcastle/keep', '');
    await linkTo(path.join(await tempDirectory(), faker.string.uuid()), 'jig.config.json');

    const refusal = await initResult({ useAgent: false });

    expect(refusal.isErr() && refusal.error).toBeInstanceOf(LocalPreparationFailed);
    expect(exists('.sandcastle/Dockerfile')).toBe(false);
  });

  it('refuses a directory below the repository root before writing or building anything', async () => {
    const { initResult, openSandboxRuntime, exists } = await setup({ startInSubdirectory: true });

    const result = await initResult({ useAgent: true });

    expect(result.isErr() && result.error).toBeInstanceOf(RepositoryInvalid);
    expect(openSandboxRuntime).not.toHaveBeenCalled();
    expect(exists('.sandcastle/Dockerfile')).toBe(false);
  });

  it('names the config it wrote, the one the operator chose', async () => {
    const customConfig = `${faker.word.noun()}.json`;
    const { initResult, write } = await setup({ customConfig });
    await write(customConfig, '{}');

    const report = unwrap(await initResult({ useAgent: false }));

    expect(report.configName).toBe(customConfig);
  });

  it('releases what it built once init is done, and when it fails', async () => {
    const { initResult, linkTo, write, runtimes, repoRoot } = await setup({ configured: true });
    await write('.sandcastle/keep', '');
    await linkTo(path.join(await tempDirectory(), faker.string.uuid()), '.sandcastle/Dockerfile');

    const refused = await initResult({ useAgent: false });
    await unlink(path.join(repoRoot(), '.sandcastle/Dockerfile'));
    const written = await initResult({ useAgent: false });

    expect(refused.isErr()).toBe(true);
    expect(written.isOk()).toBe(true);
    expect(runtimes().map((runtime) => runtime.disposed())).toEqual([true, true]);
  });

  it.each([
    [0, 'verified'],
    [faker.number.int({ min: 1, max: 255 }), 'failed'],
  ] as const)(
    'checks the configured commands without an agent, verify exiting %i reports %s',
    async (exitCode, status) => {
      const verifyCommand = `npm run ${faker.word.verb()}`;
      const { init, write, agent } = await setup({ exec: () => ({ exitCode, output: '' }) });
      await write('jig.config.json', JSON.stringify({ ...everyStepOn(), verifyCommand }));

      const outcome = await init({ useAgent: false });

      expect(outcome).toMatchObject({ status, attempts: 1 });
      expect(agent.commands).toEqual([verifyCommand]);
      expect(agent.calls).toHaveLength(0);
    },
  );

  it('runs the planner only in sandboxes it opened on branches of their own, closing each and removing its branch', async () => {
    const { init, agent, openedBranches, localBranches } = await setup({
      configured: true,
      proposals: [toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
    });

    await init({ useAgent: true });

    expect(agent.calls.map((call) => call.role)).toEqual(['planner']);
    expect(openedBranches()).toHaveLength(2);
    expect(agent.closed).toBe(true);
    expect(await localBranches()).not.toEqual(expect.arrayContaining(openedBranches()));
  });

  it('hands the sandbox a credential the operator would not save', async () => {
    const value = faker.string.alphanumeric(20);
    const { init, runtimes, askForCredential } = await setup({
      configured: true,
      environment: {},
      credential: { name: 'ANTHROPIC_API_KEY', value, save: false },
      proposals: [toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
    });

    await init({ useAgent: true });

    expect(askForCredential).toHaveBeenCalledTimes(1);
    const [sandbox] = runtimes()[0]?.settings() ?? [];
    expect(sandbox?.environment.credential('ANTHROPIC_API_KEY')).toBe(value);
  });

  async function setup(input: {
    configured?: boolean;
    configWriteFailure?: ConfigUnwritable;
    customConfig?: string;
    answer?: AgentChoice;
    environment?: Record<string, string>;
    credential?: EnteredCredential;
    proposals?: ReturnType<typeof toolchainProposal>[];
    exec?: (command: string) => ExecResult;
    checkSandboxFailures?: SessionOpenFailure[];
    startInSubdirectory?: boolean;
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
    const openedBranches: string[] = [];
    const open = async ({ runId }: RunIdentity, setupCommand: string | null) => {
      const failure = setupCommand === null ? undefined : checkSandboxFailures.shift();
      if (failure) return Result.err(failure);
      const branch = runBranchFor(runId);
      await simpleGit({ baseDir: repo.dir }).branch([branch]);
      openedBranches.push(branch);
      return Result.ok(agent);
    };
    const images = mock<SandboxImages>({
      labels: vi.fn().mockResolvedValue(Result.ok(undefined)),
      build: vi.fn().mockResolvedValue(Result.ok()),
    });
    const built: ReturnType<typeof localSandboxRuntime>[] = [];
    const openSandboxRuntime = vi.fn((request: RuntimeRequest) => {
      const runtime = localSandboxRuntime(request, { images, open, log: mock<OperationLog>() });
      built.push(runtime);
      return runtime.runtime;
    });
    const writeFailure = input.configWriteFailure;
    const sources = realRepositorySources({
      configSourceFor: (repoRoot, configPath) => {
        const source = configFileSource(configDestination(repoRoot, configPath));
        return writeFailure ? { ...source, write: async () => Result.err(writeFailure) } : source;
      },
    });
    const askForAgents = vi.fn(async (roles: AgentRole[]) => {
      const { answer } = input;
      return answer && Object.fromEntries(roles.map((role) => [role, answer]));
    });
    const askForCredential = vi.fn(async () => input.credential);
    const cwd = input.startInSubdirectory ? path.join(repo.dir, faker.word.noun()) : repo.dir;
    if (input.startInSubdirectory) await mkdir(cwd);
    const environment = input.environment ?? {
      ANTHROPIC_API_KEY: faker.string.alphanumeric(20),
      JIG_CODEX_AUTH_DIR: codexHome,
      OPENROUTER_API_KEY: faker.string.alphanumeric(20),
    };
    const initResult = (options: Pick<InitInput, 'useAgent'>) =>
      initRepository(
        {
          ...sources,
          context: () => operationContextIn(cwd, environment),
          openSandboxRuntime,
          askForAgents,
          askForCredential,
        },
        { ...options, configPath: input.customConfig, logFormat: 'json' },
      );
    const init = async (options: Pick<InitInput, 'useAgent'>) =>
      unwrap(await initResult(options)).outcome;
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
      openSandboxRuntime,
      askForCredential,
      runtimes: () => built,
      repoRoot: () => repo.dir,
      openedBranches: () => openedBranches,
      localBranches: async () => (await simpleGit({ baseDir: repo.dir }).branchLocal()).all,
      asked: () => askForAgents.mock.calls.length,
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
