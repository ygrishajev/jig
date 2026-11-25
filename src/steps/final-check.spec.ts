import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aRunStateIn, aSlice, designDocs, runSettings } from '../../tests/support/builders.js';
import { FakeWorkspace } from '../../tests/support/fake-workspace.js';
import { type AgentScript, FakeAgentSession } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import type { RunSettings } from '../domain/settings.js';
import {
  AgentOutputInvalid,
  AgentRunFailed,
  type ExecResult,
  SandboxUnavailable,
} from '../ports/agent-session.js';
import { checkWholeRun } from './final-check.js';

describe('checkWholeRun', () => {
  it('asks the reviewer whether the whole run fulfils the request, the plan and the whole range', async () => {
    const { attempt, agent, state, workspace } = await setup({
      reviewer: [{ output: { fulfilled: true, gaps: [] } }],
    });
    const forkPoint = (await workspace.forkPoint()).unwrap();

    const outcome = (await attempt()).unwrap();

    const prompt = agent.calls.at(-1)?.prompt ?? '';
    expect(prompt).toContain(state.request);
    expect(prompt).toContain(state.docs.plan);
    expect(prompt).toContain(`${forkPoint}..HEAD`);
    expect(outcome).toMatchObject({ type: 'finalChecked', fulfilled: true });
  });

  it('runs the configured verification once before the reviewer sees the run', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { attempt, agent } = await setup({
      settings: runSettings({ verifyCommand }),
      reviewer: [{ output: { fulfilled: true, gaps: [] } }],
    });

    const outcome = (await attempt()).unwrap();

    expect(agent.commands).toEqual([verifyCommand]);
    expect(outcome).toEqual({
      type: 'finalChecked',
      verified: true,
      command: verifyCommand,
      fulfilled: true,
      gaps: [],
    });
  });

  it('has the reviewer judge the run even when its verification failed', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const failure = faker.lorem.sentence();
    const { attempt, agent } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => ({ exitCode: 1, output: failure }),
      reviewer: [{ output: { fulfilled: true, gaps: [] } }],
    });

    const outcome = (await attempt()).unwrap();

    expect(agent.calls.filter((call) => call.role === 'reviewer')).toHaveLength(1);
    expect(outcome).toMatchObject({
      type: 'finalChecked',
      verified: false,
      command: verifyCommand,
      output: failure,
      fulfilled: true,
    });
  });

  it('reports no verification when none is configured, and carries the reviewer gaps', async () => {
    const gap = faker.lorem.sentence();
    const { attempt, agent } = await setup({
      reviewer: [{ output: { fulfilled: false, gaps: [gap] } }],
    });

    const outcome = (await attempt()).unwrap();

    expect(agent.commands).toEqual([]);
    expect(outcome).toEqual({
      type: 'finalChecked',
      verified: true,
      fulfilled: false,
      gaps: [gap],
    });
  });

  it('leaves the run branch untouched, committing and importing nothing', async () => {
    const { attempt, workspace } = await setup({
      reviewer: [
        {
          files: { [`${faker.string.uuid()}.txt`]: faker.lorem.word() },
          output: { fulfilled: true, gaps: [] },
        },
      ],
    });

    (await attempt()).unwrap();

    expect(workspace.history).toEqual([]);
  });

  it('passes on a sandbox that cannot run the verification at all', async () => {
    const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
    const { attempt } = await setup({
      settings: runSettings({ verifyCommand: 'npm test' }),
      exec: () => failure,
    });

    const result = await attempt();

    expect(result.isErr() && result.error).toBe(failure);
  });

  it('passes on a reviewer that cannot run', async () => {
    const failure = new AgentRunFailed({ message: faker.lorem.sentence() });
    const { attempt } = await setup({ reviewer: [{ fail: failure }] });

    const result = await attempt();

    expect(result.isErr() && result.error).toBe(failure);
  });

  it('fails when the verdict does not parse as a fulfillment', async () => {
    const { attempt } = await setup({ reviewer: [{ output: { verdict: faker.lorem.word() } }] });

    const result = await attempt();

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
  });

  async function setup(input: {
    settings?: RunSettings;
    reviewer?: AgentScript[];
    exec?: (command: string) => ExecResult | SandboxUnavailable;
  }) {
    const agent = new FakeAgentSession(await tempDirectory(), input.exec);
    const workspace = new FakeWorkspace(agent);
    agent.script('reviewer', ...(input.reviewer ?? []));
    const state = aRunStateIn('finalCheck', {
      slices: [aSlice({ status: 'approved' })],
      docs: designDocs(),
    });
    const attempt = () =>
      checkWholeRun({
        state,
        ports: { agent, workspace },
        settings: input.settings ?? runSettings(),
      });
    return { attempt, agent, state, workspace };
  }
});
