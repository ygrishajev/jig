import type {
  AgentProvider,
  AgentStreamEvent,
  Sandbox,
  SandboxRunOptions,
} from '@ai-hero/sandcastle';
import { faker } from '@faker-js/faker';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { z } from 'zod';

import { runId } from '../../../tests/support/builders.js';
import { RecordingEventSink } from '../../../tests/support/fakes.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import {
  AgentOutputInvalid,
  AgentRunFailed,
  ConfigInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
} from '../../domain/errors.js';
import type { AgentRole } from '../../ports/agent-session.js';
import { AGENTS } from './agents.js';
import { type SandboxFactory, SandcastleSession } from './sandcastle-session.js';
import { OUTPUT_TAG } from './structured-output.js';

describe('SandcastleSession', () => {
  it('uses Codex resume syntax when correcting invalid output', async () => {
    const answer = { summary: faker.lorem.sentence() };
    const { open, runs, agents } = await setup({
      replies: [{ stdout: faker.lorem.sentence() }, { stdout: tagged(answer) }],
    });
    agents.planner = AGENTS.codex.create(faker.word.noun());
    expect(await (await open()).runForOutput(outputCall())).toEqual(answer);
    const prompt = faker.lorem.sentence();
    const command = runs[1].agent.buildPrintCommand({ ...printOptions(), prompt });
    expect(command.command).toContain('codex exec resume --last');
    expect(command.command).not.toContain('--continue');
    expect(command.stdin).toBe(prompt);
  });

  it('returns the result the agent tagged in its reply', async () => {
    const answer = { summary: faker.lorem.sentence() };
    const { open } = await setup({ replies: [{ stdout: tagged(answer) }] });

    expect(await (await open()).runForOutput(outputCall())).toEqual(answer);
  });

  it('asks the same agent, in its own conversation, to correct a reply that did not parse', async () => {
    const answer = { summary: faker.lorem.sentence() };
    const { open, runs, printCommand } = await setup({
      replies: [{ stdout: faker.lorem.paragraph() }, { stdout: tagged(answer) }],
    });

    const result = await (await open()).runForOutput(outputCall());

    expect(result).toEqual(answer);
    expect(runs).toHaveLength(2);
    expect(runs[0].agent.buildPrintCommand(printOptions()).command).toBe(printCommand);
    expect(runs[1].agent.buildPrintCommand(printOptions()).command).toBe(
      `${printCommand} --continue`,
    );
    expect(runs[1].prompt).toContain(OUTPUT_TAG);
  });

  it('gives up with invalid output once the correction does not parse either', async () => {
    const { open, runs } = await setup({
      replies: [{ stdout: tagged({ wrong: 1 }) }, { stdout: tagged({ wrong: 2 }) }],
    });

    await expect((await open()).runForOutput(outputCall())).rejects.toBeInstanceOf(
      AgentOutputInvalid,
    );
    expect(runs).toHaveLength(2);
  });

  it('reports an agent the sandbox could not run as a failed agent run', async () => {
    const { open } = await setup({ replies: [{ fail: new Error(faker.lorem.sentence()) }] });

    await expect(
      (await open()).run({ role: 'implementer', prompt: faker.lorem.paragraph() }),
    ).rejects.toBeInstanceOf(AgentRunFailed);
  });

  it("runs each role's own agent with the prompt it was given", async () => {
    const prompt = faker.lorem.paragraph();
    const { open, runs, agents } = await setup({ replies: [{ stdout: '' }] });

    await (await open()).run({ role: 'reviewer', prompt });

    expect(runs[0]).toMatchObject({ agent: agents.reviewer, prompt });
  });

  it("publishes the agent's messages, tool calls and usage as run events for its role", async () => {
    const text = faker.lorem.sentence();
    const tool = faker.word.verb();
    const args = faker.lorem.words();
    const costUsd = faker.number.float({ min: 0.01, max: 1, fractionDigits: 4 });
    const input = faker.number.int({ min: 1, max: 10_000 });
    const { open, events, id } = await setup({
      replies: [
        {
          stdout: '',
          events: [
            { type: 'text', message: text, iteration: 1, timestamp: new Date() },
            {
              type: 'toolCall',
              name: tool,
              formattedArgs: args,
              iteration: 1,
              timestamp: new Date(),
            },
            { type: 'raw', line: faker.lorem.sentence(), iteration: 1, timestamp: new Date() },
            {
              type: 'raw',
              line: JSON.stringify({
                type: 'result',
                total_cost_usd: costUsd,
                usage: { input_tokens: input },
              }),
              iteration: 1,
              timestamp: new Date(),
            },
          ],
        },
      ],
    });

    await (await open()).run({ role: 'implementer', prompt: faker.lorem.paragraph() });

    expect(events.events).toEqual([
      { type: 'agentMessage', runId: id, role: 'implementer', text },
      { type: 'agentToolCall', runId: id, role: 'implementer', tool, args },
      {
        type: 'agentUsage',
        runId: id,
        role: 'implementer',
        costUsd,
        tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      },
    ]);
  });

  it("returns a command's exit code with its stdout and stderr together", async () => {
    const stdout = faker.lorem.sentence();
    const stderr = faker.lorem.sentence();
    const exitCode = faker.number.int({ min: 0, max: 255 });
    const { open } = await setup({ exitCode, stdout: `  ${stdout}`, stderr: `${stderr}\n` });

    expect(await (await open()).exec(faker.lorem.word())).toEqual({
      exitCode,
      output: `${stdout}${stderr}`,
    });
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
    stdout?: string;
    stderr?: string;
    hangs?: boolean;
    execFails?: Error;
    replies?: Reply[];
  }) {
    const repoRoot = await tempDirectory('jig-session-');
    const id = runId();
    const events = new RecordingEventSink();
    const replies = [...(input.replies ?? [])];
    const runs: SandboxRunOptions[] = [];
    const result = {
      exitCode: input.exitCode ?? 0,
      stdout: input.stdout ?? '',
      stderr: input.stderr ?? '',
    };
    const sandbox = mock<Sandbox>({
      worktreePath: repoRoot,
      exec: vi.fn<Sandbox['exec']>(async () => {
        if (input.execFails) throw input.execFails;
        return input.hangs ? new Promise(() => {}) : result;
      }),
      run: vi.fn<Sandbox['run']>(async (options) => {
        runs.push(options);
        const reply = replies.shift();
        if (!reply) throw new Error('No sandbox reply scripted');
        if ('fail' in reply) throw reply.fail;
        for (const event of reply.events ?? []) {
          if (options.logging?.type === 'file') options.logging.onAgentStreamEvent?.(event);
        }
        return { iterations: [], stdout: reply.stdout, commits: [] };
      }),
      close: vi.fn<Sandbox['close']>().mockResolvedValue({}),
    });
    const start: SandboxFactory = input.start ?? (async () => sandbox);
    const printCommand = `${faker.word.noun()} -p`;
    const anAgent = () =>
      mock<AgentProvider>({ buildPrintCommand: () => ({ command: printCommand }) });
    const agents: Record<AgentRole, AgentProvider> = {
      planner: anAgent(),
      implementer: anAgent(),
      reviewer: anAgent(),
      describer: anAgent(),
    };
    const open = () =>
      SandcastleSession.open(
        {
          repoRoot,
          runId: id,
          baseBranch: 'main',
          imageName: `sandcastle:${faker.word.noun()}`,
          credentials: {},
          agents,
          skipCommitSigning: false,
          setupCommand: input.setupCommand,
          setupTimeoutSeconds: input.setupTimeoutSeconds ?? 60,
          idleTimeoutSeconds: 60,
          agentLogFile: path.join(repoRoot, 'agents.log'),
          events,
        },
        start,
      );
    return { open, sandbox, runs, agents, printCommand, events, id };
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

type Reply = { stdout: string; events?: AgentStreamEvent[] } | { fail: Error };

const answerSchema = z.object({ summary: z.string() });

function outputCall() {
  const role: AgentRole = 'planner';
  return { role, prompt: faker.lorem.paragraph(), schema: answerSchema };
}

function tagged(value: unknown) {
  return `${faker.lorem.sentence()}\n<${OUTPUT_TAG}>${JSON.stringify(value)}</${OUTPUT_TAG}>`;
}

function printOptions() {
  return { prompt: faker.lorem.sentence(), dangerouslySkipPermissions: true };
}

function rejectingWith(error: Error): SandboxFactory {
  return async () => {
    throw error;
  };
}
