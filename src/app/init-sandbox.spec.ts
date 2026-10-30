import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { TOOLCHAIN_END, TOOLCHAIN_START } from '../adapters/sandbox-image/image-recipe.js';
import type { ExecResult } from '../ports/agent-session.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import { FakeAgentSession } from '../../tests/support/fakes.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { ConfigInvalid, SandboxUnavailable, SetupCommandFailed } from '../domain/errors.js';
import { createAppContainer, type OpenSessionInput } from './container.js';
import { initSandbox } from './init-sandbox.js';

describe('initSandbox', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('writes the sandbox Dockerfile, its gitignore and a starter config', async () => {
    const { init, file } = await setup({});

    expect(await init({ useAgent: false })).toEqual({ status: 'written' });
    expect(await file('.sandcastle/Dockerfile')).toContain(TOOLCHAIN_START);
    expect(await file('.sandcastle/.gitignore')).toContain('worktrees/');
    expect(JSON.parse(await file('sdlc.config.json'))).toEqual({});
  });

  it('keeps a Dockerfile and config the repository already has', async () => {
    const dockerfile = `FROM ${faker.word.noun()}`;
    const config = { verifyCommand: `npm run ${faker.word.verb()}` };
    const { init, file, write } = await setup({ exec: () => ({ exitCode: 0, output: '' }) });
    await write('.sandcastle/Dockerfile', dockerfile);
    await write('sdlc.config.json', JSON.stringify(config));

    await init({ useAgent: false });

    expect(await file('.sandcastle/Dockerfile')).toBe(dockerfile);
    expect(JSON.parse(await file('sdlc.config.json'))).toEqual(config);
  });

  it('stops a catch-all gitignore from hiding the Dockerfile', async () => {
    const { init, file, write } = await setup({});
    await write('.sandcastle/.gitignore', '*\n');

    await init({ useAgent: false });

    expect((await file('.sandcastle/.gitignore')).split('\n')).not.toContain('*');
  });

  it("writes the planner's toolchain and commands once they pass in the sandbox", async () => {
    const proposal = toolchainProposal();
    const { init, file, agent } = await setup({
      proposals: [proposal],
      exec: () => ({ exitCode: 0, output: '' }),
    });

    expect(await init({ useAgent: true })).toEqual({ status: 'verified', attempts: 1 });
    expect(await file('.sandcastle/Dockerfile')).toContain(
      `${TOOLCHAIN_START}\n${proposal.toolchain}\n${TOOLCHAIN_END}`,
    );
    expect(JSON.parse(await file('sdlc.config.json'))).toEqual({
      setupCommand: proposal.setupCommand,
      verifyCommand: proposal.verifyCommand,
    });
    expect(agent.commands).toEqual([proposal.verifyCommand]);
  });

  it('hands a failing check back to the planner and accepts the corrected toolchain', async () => {
    const failure = faker.lorem.sentence();
    const results: ExecResult[] = [{ exitCode: 1, output: failure }];
    const { init, agent } = await setup({
      proposals: [toolchainProposal(), toolchainProposal()],
      exec: () => results.shift() ?? { exitCode: 0, output: '' },
    });

    expect(await init({ useAgent: true })).toEqual({ status: 'verified', attempts: 2 });
    expect(agent.calls[1].prompt).toContain(failure);
  });

  it('gives up after three attempts and reports the last failure', async () => {
    const failure = faker.lorem.sentence();
    const { init } = await setup({
      proposals: [toolchainProposal(), toolchainProposal(), toolchainProposal()],
      exec: () => ({ exitCode: 2, output: failure }),
    });

    const result = await init({ useAgent: true });

    expect(result).toMatchObject({ status: 'failed', attempts: 3 });
    expect(result.status === 'failed' && result.failure).toContain(failure);
  });

  it('hands a failing setup command back to the planner', async () => {
    const failure = new SetupCommandFailed(faker.lorem.sentence(), faker.lorem.sentence());
    const { init, agent } = await setup({
      proposals: [toolchainProposal(), toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
      checkSandboxFailures: [failure],
    });

    expect(await init({ useAgent: true })).toEqual({ status: 'verified', attempts: 2 });
    expect(agent.calls[1].prompt).toContain(failure.message);
  });

  it.each([
    ['a sandbox that would not start', () => new SandboxUnavailable(faker.lorem.sentence())],
    ['missing credentials', () => new ConfigInvalid(faker.lorem.sentence())],
  ])('stops on %s instead of spending the planner on it', async (_case, failure) => {
    const error = failure();
    const { init, agent } = await setup({
      proposals: [toolchainProposal(), toolchainProposal()],
      exec: () => ({ exitCode: 0, output: '' }),
      checkSandboxFailures: [error],
    });

    await expect(init({ useAgent: true })).rejects.toBe(error);
    expect(agent.calls).toHaveLength(1);
  });

  async function setup(input: {
    proposals?: ReturnType<typeof toolchainProposal>[];
    exec?: (command: string) => ExecResult;
    checkSandboxFailures?: Error[];
  }) {
    const repo = await createTempRepo();
    cleanups.push(repo.cleanup);
    const agent = new FakeAgentSession(repo.dir, input.exec);
    for (const proposal of input.proposals ?? []) agent.script('planner', { output: proposal });

    const checkSandboxFailures = [...(input.checkSandboxFailures ?? [])];
    const app = createAppContainer({ repoRoot: repo.dir, logFormat: 'json', logLevel: 'silent' });
    app.register({
      images: asValue(mock<SandboxImages>({ labels: vi.fn().mockResolvedValue(undefined) })),
      latestVersions: asValue(async () => ({})),
      openSession: asValue(async ({ setupCommand }: OpenSessionInput) => {
        const failure = setupCommand === null ? undefined : checkSandboxFailures.shift();
        if (failure) throw failure;
        return agent;
      }),
    });
    const init = (options: { useAgent: boolean }) => initSandbox(app, options);
    const file = (relativePath: string) => readFile(path.join(repo.dir, relativePath), 'utf-8');
    const write = async (relativePath: string, contents: string) => {
      const target = path.join(repo.dir, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    };
    return { init, file, write, agent };
  }
});

function toolchainProposal() {
  return {
    toolchain: `RUN apt-get update && apt-get install -y ${faker.word.noun()}`,
    setupCommand: `npm ${faker.word.verb()}`,
    verifyCommand: `npm run ${faker.word.verb()}`,
  };
}
