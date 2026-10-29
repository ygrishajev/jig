import { faker } from '@faker-js/faker';
import type { AgentProvider, Sandbox } from '@ai-hero/sandcastle';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { runId } from '../../../tests/support/builders.js';
import { RecordingEventSink } from '../../../tests/support/fakes.js';
import { ConfigInvalid, SandboxUnavailable, SetupCommandFailed } from '../../domain/errors.js';
import { SandcastleSession, type SandboxFactory } from './sandcastle-session.js';

describe('SandcastleSession.open', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('treats a repository path sandcastle cannot use as a configuration problem', async () => {
    const { open } = await setup({ start: rejectingWith(sandcastleFailure('CwdError')) });

    await expect(open()).rejects.toBeInstanceOf(ConfigInvalid);
  });

  it.each(['WorktreeError', 'ContainerStartTimeoutError', 'DockerError', 'ExecError'])(
    'treats %s while starting as a sandbox that may well start on the next try',
    async (tag) => {
      const { open } = await setup({ start: rejectingWith(sandcastleFailure(tag)) });

      const failure = open();

      await expect(failure).rejects.toBeInstanceOf(SandboxUnavailable);
      await expect(failure).rejects.toMatchObject({ kind: 'retry' });
    },
  );

  it("treats a failure that is not one of sandcastle's own as one worth retrying", async () => {
    const { open } = await setup({
      start: rejectingWith(new Error(faker.lorem.sentence())),
    });

    await expect(open()).rejects.toBeInstanceOf(SandboxUnavailable);
  });

  it('runs the setup command in the new sandbox before handing it over', async () => {
    const setupCommand = `npm ${faker.word.verb()}`;
    const { open, sandbox } = await setup({ setupCommand, exitCode: 0 });

    await open();

    expect(sandbox.exec).toHaveBeenCalledWith(setupCommand);
    expect(sandbox.close).not.toHaveBeenCalled();
  });

  it('closes the sandbox and reports the setup command when it exits non-zero', async () => {
    const output = faker.lorem.sentence();
    const { open, sandbox } = await setup({
      setupCommand: `npm ${faker.word.verb()}`,
      exitCode: faker.number.int({ min: 1, max: 255 }),
      stderr: output,
    });

    const failure = open();

    await expect(failure).rejects.toBeInstanceOf(SetupCommandFailed);
    await expect(failure).rejects.toMatchObject({ output });
    expect(sandbox.close).toHaveBeenCalled();
  });

  it('closes the sandbox and reports the setup command when it outlives its timeout', async () => {
    const { open, sandbox } = await setup({
      setupCommand: `npm ${faker.word.verb()}`,
      setupTimeoutSeconds: 0.01,
      hangs: true,
    });

    await expect(open()).rejects.toBeInstanceOf(SetupCommandFailed);
    expect(sandbox.close).toHaveBeenCalled();
  });

  it('closes the sandbox and retries when the setup command could not be run at all', async () => {
    const { open, sandbox } = await setup({
      setupCommand: `npm ${faker.word.verb()}`,
      execFails: new Error(faker.lorem.sentence()),
    });

    await expect(open()).rejects.toBeInstanceOf(SandboxUnavailable);
    expect(sandbox.close).toHaveBeenCalled();
  });

  async function setup(input: {
    start?: SandboxFactory;
    setupCommand?: string;
    setupTimeoutSeconds?: number;
    exitCode?: number;
    stderr?: string;
    hangs?: boolean;
    execFails?: Error;
  }) {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'sdlc-session-'));
    directories.push(repoRoot);
    const result = { exitCode: input.exitCode ?? 0, stdout: '', stderr: input.stderr ?? '' };
    const sandbox = mock<Sandbox>({
      worktreePath: repoRoot,
      exec: vi.fn<Sandbox['exec']>(async () => {
        if (input.execFails) throw input.execFails;
        return input.hangs ? new Promise(() => {}) : result;
      }),
      close: vi.fn<Sandbox['close']>().mockResolvedValue({}),
    });
    const start: SandboxFactory = input.start ?? (async () => sandbox);
    const agent = mock<AgentProvider>();
    const open = () =>
      SandcastleSession.open(
        {
          repoRoot,
          runId: runId(),
          baseBranch: 'main',
          imageName: `sandcastle:${faker.word.noun()}`,
          credentials: {},
          agents: { planner: agent, implementer: agent, reviewer: agent, describer: agent },
          skipCommitSigning: false,
          setupCommand: input.setupCommand,
          setupTimeoutSeconds: input.setupTimeoutSeconds ?? 60,
          idleTimeoutSeconds: 60,
          agentLogFile: path.join(repoRoot, 'agents.log'),
          events: new RecordingEventSink(),
        },
        start,
      );
    return { open, sandbox };
  }
});

/**
 * Sandcastle runs on Effect, whose `runPromise` rejects with a FiberFailure that carries the
 * tagged error under this symbol — the shape `createSandbox` was seen to reject with.
 */
function sandcastleFailure(tag: string) {
  const failure = new Error(faker.lorem.sentence());
  Object.defineProperty(failure, Symbol.for('effect/Runtime/FiberFailure/Cause'), {
    value: { _tag: 'Fail', error: { _tag: tag, message: failure.message } },
  });
  return failure;
}

function rejectingWith(error: Error): SandboxFactory {
  return async () => {
    throw error;
  };
}
