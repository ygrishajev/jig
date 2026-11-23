import type {
  AgentProvider,
  AgentStreamEvent,
  Sandbox,
  SandboxRunOptions,
} from '@ai-hero/sandcastle';
import { faker } from '@faker-js/faker';
import { panic } from 'better-result';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { z } from 'zod';

import { runId } from '../../../tests/support/builders.js';
import { RecordingEventSink } from '../../../tests/support/fakes.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import {
  AgentOutputInvalid,
  type AgentRole,
  AgentRunFailed,
  SandboxPreparationInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
} from '../../ports/agent-session.js';
import { LocalPreparationFailed } from '../../ports/local-state.js';
import { AGENTS } from './agents.js';
import { openCodexAuthCache } from './codex-auth.js';
import { type SandboxFactory, SandcastleSession } from './sandcastle-session.js';
import { OUTPUT_TAG } from './structured-output.js';

describe('SandcastleSession', () => {
  it('uses Codex resume syntax when correcting invalid output', async () => {
    const answer = { summary: faker.lorem.sentence() };
    const { open, runs, agents } = await setup({
      replies: [{ stdout: faker.lorem.sentence() }, { stdout: tagged(answer) }],
    });
    agents.planner = unwrap(AGENTS.codex.create(faker.word.noun()));
    expect(unwrap(await (await open()).runForOutput(outputCall()))).toEqual(answer);
    const prompt = faker.lorem.sentence();
    const command = runs[1].agent.buildPrintCommand({ ...printOptions(), prompt });
    expect(command.command).toContain('codex exec resume --last');
    expect(command.command).not.toContain('--continue');
    expect(command.stdin).toBe(prompt);
  });

  it('returns the result the agent tagged in its reply', async () => {
    const answer = { summary: faker.lorem.sentence() };
    const { open } = await setup({ replies: [{ stdout: tagged(answer) }] });

    expect(unwrap(await (await open()).runForOutput(outputCall()))).toEqual(answer);
  });

  it('asks the same agent, in its own conversation, to correct a reply that did not parse', async () => {
    const answer = { summary: faker.lorem.sentence() };
    const { open, runs, printCommand } = await setup({
      replies: [{ stdout: faker.lorem.paragraph() }, { stdout: tagged(answer) }],
    });

    const result = await (await open()).runForOutput(outputCall());

    expect(unwrap(result)).toEqual(answer);
    expect(runs).toHaveLength(2);
    expect(runs[0].agent.buildPrintCommand(printOptions()).command).toBe(printCommand);
    expect(runs[1].agent.buildPrintCommand(printOptions()).command).toBe(
      `${printCommand} --continue`,
    );
    expect(runs[1].prompt).toContain(OUTPUT_TAG);
  });

  it('asks once for a correction, then reports output it cannot parse', async () => {
    const { open, runs } = await setup({
      replies: [{ stdout: tagged({ wrong: 1 }) }, { stdout: tagged({ wrong: 2 }) }],
    });

    const result = await (await open()).runForOutput(outputCall());

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
    expect(runs).toHaveLength(2);
  });

  it('reports an agent the sandbox could not run as a failed agent run', async () => {
    const { open } = await setup({ replies: [{ fail: new Error(faker.lorem.sentence()) }] });

    const result = await (
      await open()
    ).run({
      role: 'implementer',
      prompt: faker.lorem.paragraph(),
    });

    expect(result.isErr() && result.error).toBeInstanceOf(AgentRunFailed);
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

    expect(unwrap(await (await open()).exec(faker.lorem.word()))).toEqual({
      exitCode,
      output: `${stdout}${stderr}`,
    });
  });

  it('reports a command the sandbox could not run as an unavailable sandbox', async () => {
    const { open } = await setup({ execFails: new Error(faker.lorem.sentence()) });

    const result = await (await open()).exec(faker.lorem.word());

    expect(result.isErr() && result.error).toBeInstanceOf(SandboxUnavailable);
  });

  it('reports a sandbox that will not stop, and still lets go of the Codex login', async () => {
    const { open, codexLoginIsFree } = await setup({
      closeFails: new Error(faker.lorem.sentence()),
      withCodexLogin: true,
    });

    const closed = await (await open()).close();

    expect(closed.isErr() && closed.error).toBeInstanceOf(SandboxUnavailable);
    expect(await codexLoginIsFree()).toBe(true);
  });

  it('starts no sandbox when the sandcastle gitignore links out of the repository', async () => {
    const start = vi.fn<SandboxFactory>();
    const { failure, repoRoot } = await setup({ start });
    const outside = path.join(await tempDirectory(), faker.string.uuid());
    const original = `${faker.lorem.word()}\n*\n`;
    await writeFile(outside, original);
    await mkdir(path.join(repoRoot, '.sandcastle'));
    await symlink(outside, path.join(repoRoot, '.sandcastle', '.gitignore'));

    expect(await failure()).toBeInstanceOf(LocalPreparationFailed);
    expect(start).not.toHaveBeenCalled();
    expect(await readFile(outside, 'utf-8')).toBe(original);
  });

  it('treats a repository path sandcastle cannot use as a configuration problem', async () => {
    const { failure } = await setup({ start: rejectingWith(sandcastleFailure('CwdError')) });

    expect(await failure()).toBeInstanceOf(SandboxPreparationInvalid);
  });

  it.each(['WorktreeError', 'ContainerStartTimeoutError', 'DockerError', 'ExecError'])(
    'treats %s while starting as a sandbox that may well start on the next try',
    async (tag) => {
      const { failure } = await setup({ start: rejectingWith(sandcastleFailure(tag)) });

      const error = await failure();

      expect(error).toBeInstanceOf(SandboxUnavailable);
      expect(error).toMatchObject({ kind: 'retry' });
    },
  );

  it("treats a failure that is not one of sandcastle's own as one worth retrying", async () => {
    const { failure } = await setup({
      start: rejectingWith(new Error(faker.lorem.sentence())),
    });

    expect(await failure()).toBeInstanceOf(SandboxUnavailable);
  });

  it('reports a sandbox that will not start as unavailable', async () => {
    const { failure, codexLoginIsFree } = await setup({
      start: rejectingWith(new Error(faker.lorem.sentence())),
      withCodexLogin: true,
    });

    expect(await failure()).toBeInstanceOf(SandboxUnavailable);
    expect(await codexLoginIsFree()).toBe(true);
  });

  it('runs the setup command in the new sandbox before handing it over', async () => {
    const setupCommand = `npm ${faker.word.verb()}`;
    const { open, sandbox } = await setup({ setupCommand, exitCode: 0 });

    await open();

    expect(sandbox.exec).toHaveBeenCalledWith(setupCommand);
    expect(sandbox.close).not.toHaveBeenCalled();
  });

  it("installs the repository's git hooks after the setup command", async () => {
    const setupCommand = `npm ${faker.word.verb()}`;
    const { open, sandbox } = await setup({ setupCommand, husky: true });

    await open();

    expect(sandbox.exec.mock.calls.map(([command]) => command)).toEqual([
      setupCommand,
      'npx --no -- husky',
    ]);
  });

  it('installs no git hooks without a setup command to install their manager', async () => {
    const { open, sandbox } = await setup({ husky: true });

    await open();

    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it('closes the sandbox and reports git hooks that fail to install', async () => {
    const output = faker.lorem.sentence();
    const { failure, sandbox } = await setup({
      setupCommand: `npm ${faker.word.verb()}`,
      husky: true,
      execResults: [{ exitCode: 0 }, { exitCode: 1, stderr: output }],
    });

    const error = await failure();

    expect(error).toBeInstanceOf(SetupCommandFailed);
    expect(error).toMatchObject({ output });
    expect(sandbox.close).toHaveBeenCalled();
  });

  it('reports a setup command that exits non-zero with its output', async () => {
    const output = faker.lorem.sentence();
    const { failure, sandbox } = await setup({
      setupCommand: `npm ${faker.word.verb()}`,
      exitCode: faker.number.int({ min: 1, max: 255 }),
      stderr: output,
    });

    const error = await failure();

    expect(error).toBeInstanceOf(SetupCommandFailed);
    expect(error).toMatchObject({ output });
    expect(sandbox.close).toHaveBeenCalled();
  });

  it('closes the sandbox and reports the setup command when it outlives its timeout', async () => {
    const { failure, sandbox } = await setup({
      setupCommand: `npm ${faker.word.verb()}`,
      setupTimeoutSeconds: 0.01,
      hangs: true,
    });

    expect(await failure()).toBeInstanceOf(SetupCommandFailed);
    expect(sandbox.close).toHaveBeenCalled();
  });

  it('closes the sandbox and retries when the setup command could not be run at all', async () => {
    const { failure, sandbox } = await setup({
      setupCommand: `npm ${faker.word.verb()}`,
      execFails: new Error(faker.lorem.sentence()),
    });

    expect(await failure()).toBeInstanceOf(SandboxUnavailable);
    expect(sandbox.close).toHaveBeenCalled();
  });

  it('keeps the setup failure when the sandbox will not stop after it', async () => {
    const { failure } = await setup({
      setupCommand: `npm ${faker.word.verb()}`,
      exitCode: 1,
      closeFails: new Error(faker.lorem.sentence()),
    });

    expect(await failure()).toBeInstanceOf(SetupCommandFailed);
  });

  async function setup(input: {
    start?: SandboxFactory;
    closeFails?: Error;
    setupCommand?: string;
    setupTimeoutSeconds?: number;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    hangs?: boolean;
    execFails?: Error;
    replies?: Reply[];
    withCodexLogin?: boolean;
    husky?: boolean;
    execResults?: { exitCode: number; stderr?: string }[];
  }) {
    const repoRoot = await tempDirectory('jig-session-');
    if (input.husky) await mkdir(path.join(repoRoot, '.husky'));
    const execResults = [...(input.execResults ?? [])];
    const codexAuthDirectory = input.withCodexLogin ? await codexLoginDirectory() : undefined;
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
        if (input.hangs) return new Promise(() => {});
        const scripted = execResults.shift();
        return scripted ? { stdout: '', stderr: '', ...scripted } : result;
      }),
      run: vi.fn<Sandbox['run']>(async (options) => {
        runs.push(options);
        const reply = replies.shift();
        if (!reply) panic('No sandbox reply scripted');
        if ('fail' in reply) throw reply.fail;
        for (const event of reply.events ?? []) {
          if (options.logging?.type === 'file') options.logging.onAgentStreamEvent?.(event);
        }
        return { iterations: [], stdout: reply.stdout, commits: [] };
      }),
      close: input.closeFails
        ? vi.fn<Sandbox['close']>().mockRejectedValue(input.closeFails)
        : vi.fn<Sandbox['close']>().mockResolvedValue({}),
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
    const tryOpen = () =>
      SandcastleSession.open(
        {
          repoRoot,
          codexAuthDirectory,
          runId: id,
          baseBranch: 'main',
          imageName: `sandcastle:${faker.word.noun()}`,
          credentials: {},
          agents,
          setupCommand: input.setupCommand,
          setupTimeoutSeconds: input.setupTimeoutSeconds ?? 60,
          idleTimeoutSeconds: 60,
          agentLogFile: path.join(repoRoot, 'agents.log'),
          events,
          logger: pino({ level: 'silent' }),
        },
        start,
      );
    const open = async () => unwrap(await tryOpen());
    const failure = async () => {
      const result = await tryOpen();
      if (result.isOk()) panic('The session opened');
      return result.error;
    };
    const codexLoginIsFree = async () => {
      if (!codexAuthDirectory) return false;
      const cache = unwrap(await openCodexAuthCache(codexAuthDirectory));
      await cache.close();
      return true;
    };
    return {
      open,
      failure,
      codexLoginIsFree,
      sandbox,
      runs,
      agents,
      printCommand,
      events,
      id,
      repoRoot,
    };
  }
});

async function codexLoginDirectory() {
  const directory = await tempDirectory('jig-codex-');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: faker.string.alphanumeric(40),
        id_token: faker.string.alphanumeric(40),
        refresh_token: faker.string.alphanumeric(40),
        account_id: faker.string.uuid(),
      },
    }),
  );
  return directory;
}

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
