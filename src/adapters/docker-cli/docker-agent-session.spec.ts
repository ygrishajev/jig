import { faker } from '@faker-js/faker';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { z } from 'zod';
import { AgentOutputInvalid, AgentRunFailed } from '../../domain/errors.js';
import type { AgentRole } from '../../ports/agent-session.js';
import { DockerAgentSession, STRUCTURED_OUTPUT_FILE } from './docker-agent-session.js';
import type { AgentProvider, AgentRunInput } from './types.js';

describe('DockerAgentSession', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("hands each role's prompt to that role's agent, in the run's worktree", async () => {
    const prompt = faker.lorem.paragraph();
    const { session, providers, worktreePath, repoRoot } = await setup({});

    await session.run({ role: 'implementer', prompt });

    expect(providers.implementer.run).toHaveBeenCalledWith({ cwd: worktreePath, repoRoot, prompt });
    expect(providers.reviewer.run).not.toHaveBeenCalled();
  });

  it('reports an agent that exits unsuccessfully as a failed run', async () => {
    const output = faker.lorem.sentence();
    const { session } = await setup({ reply: () => ({ success: false, output }) });

    await expect(session.run({ role: 'planner', prompt: faker.lorem.sentence() })).rejects.toThrow(
      new AgentRunFailed(`The planner agent failed: ${output}`),
    );
  });

  it('returns the structured answer the agent left, and removes the file afterwards', async () => {
    const answer = { verdict: faker.lorem.word() };
    const { session, worktreePath } = await setup({ writes: JSON.stringify(answer) });

    const result = await session.runForOutput({
      role: 'reviewer',
      prompt: faker.lorem.sentence(),
      schema: z.object({ verdict: z.string() }),
    });

    expect(result).toEqual(answer);
    expect(existsSync(path.join(worktreePath, STRUCTURED_OUTPUT_FILE))).toBe(false);
  });

  it('tells the agent where to leave its structured answer', async () => {
    const { session, providers } = await setup({ writes: '{}' });

    await session.runForOutput({
      role: 'planner',
      prompt: faker.lorem.sentence(),
      schema: z.object({}),
    });

    expect(providers.planner.run.mock.calls[0][0].prompt).toContain(STRUCTURED_OUTPUT_FILE);
  });

  it('rejects an answer that is missing, not JSON, or the wrong shape', async () => {
    const missing = await setup({});
    const notJson = await setup({ writes: faker.lorem.sentence() });
    const wrongShape = await setup({ writes: JSON.stringify({ verdict: faker.number.int() }) });
    const ask = (session: DockerAgentSession) =>
      session.runForOutput({
        role: 'reviewer',
        prompt: faker.lorem.sentence(),
        schema: z.object({ verdict: z.string() }),
      });

    await expect(ask(missing.session)).rejects.toBeInstanceOf(AgentOutputInvalid);
    await expect(ask(notJson.session)).rejects.toBeInstanceOf(AgentOutputInvalid);
    await expect(ask(wrongShape.session)).rejects.toBeInstanceOf(AgentOutputInvalid);
  });

  it('runs a command in the worktree and reports its exit code and output', async () => {
    const { session } = await setup({});

    const passed = await session.exec('pwd');
    const failed = await session.exec('echo broken >&2; exit 3');

    expect(passed.exitCode).toBe(0);
    expect(failed).toEqual({ exitCode: 3, output: 'broken' });
  });

  async function setup(input: {
    reply?: () => { success: boolean; output: string };
    writes?: string;
  }) {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'sdlc-session-'));
    directories.push(repoRoot);
    const worktreePath = repoRoot;
    const agentRun = async ({ cwd }: AgentRunInput) => {
      if (input.writes !== undefined)
        await writeFile(path.join(cwd, STRUCTURED_OUTPUT_FILE), input.writes);
      return input.reply?.() ?? { success: true, output: faker.lorem.sentence() };
    };
    const roles: AgentRole[] = ['planner', 'implementer', 'reviewer', 'describer'];
    const providers = Object.fromEntries(
      roles.map((role) => [role, mock<AgentProvider>({ run: vi.fn(agentRun) })]),
    ) as Record<AgentRole, ReturnType<typeof mock<AgentProvider>>>;
    const session = new DockerAgentSession({ providers, worktreePath, repoRoot });
    return { session, providers, worktreePath, repoRoot };
  }
});
