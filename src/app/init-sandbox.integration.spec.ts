import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
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
import type { AgentChoice, EnteredCredential } from '../config/agent-policy.js';
import { ConfigUnwritable } from '../config/config-source.js';
import type { AgentRole } from '../domain/agent-role.js';
import { runBranchFor, type RunIdentity } from '../domain/run-state.js';
import { type ExecResult } from '../ports/agent-session.js';
import type { OperationLog } from '../ports/observability.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import { type InitInput, initRepository, type RuntimeRequest } from './api.js';
import type { SandboxOpenFailure } from './sandbox-runtime.js';

describe('initRepository on real git', () => {
  it('saves a credential entered at the prompt to the ignored file when asked to', async () => {
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

  async function setup(input: {
    configured?: boolean;
    configWriteFailure?: ConfigUnwritable;
    customConfig?: string;
    answer?: AgentChoice;
    environment?: Record<string, string>;
    credential?: EnteredCredential;
    proposals?: ReturnType<typeof toolchainProposal>[];
    exec?: (command: string) => ExecResult;
    checkSandboxFailures?: SandboxOpenFailure[];
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
