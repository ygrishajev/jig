import { faker } from '@faker-js/faker';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { AgentRole } from '../../domain/agent-role.js';
import { AGENTS } from '../sandcastle/agents.js';
import { askForAgents } from './ask-for-agents.js';

const ENTER = '\r';
const SPACE = ' ';
const DOWN = '\u001B[B';
const UP = '\u001B[A';
const CTRL_C = '\u0003';
const TOGGLE_FIRST = `${SPACE}${ENTER}`;
const TOGGLE_SECOND = `${DOWN}${SPACE}${ENTER}`;
const TOGGLE_LAST = `${UP}${SPACE}${ENTER}`;
const TOGGLE_ALL_AGENTS_BUT_OPENCODE = `${SPACE}${DOWN}${DOWN}${SPACE}${ENTER}`;
const [FIRST_CLAUDE, SECOND_CLAUDE] = AGENTS.claude.modelOptions;
const [FIRST_CODEX] = AGENTS.codex.modelOptions;

describe('askForAgents', () => {
  it('gives every role the one model chosen, asking no more', async () => {
    const { answer, type } = setup({ roles: ['planner', 'describer'] });

    await type(TOGGLE_FIRST, TOGGLE_FIRST);

    const agent = { provider: 'claude', model: FIRST_CLAUDE };
    expect(await answer).toEqual({ planner: agent, describer: agent });
  });

  it('asks which model each role uses when several agents are chosen', async () => {
    const { answer, type } = setup({ roles: ['planner', 'reviewer'] });

    await type(
      TOGGLE_ALL_AGENTS_BUT_OPENCODE,
      TOGGLE_FIRST,
      TOGGLE_FIRST,
      ENTER,
      `${DOWN}${ENTER}`,
    );

    expect(await answer).toEqual({
      planner: { provider: 'claude', model: FIRST_CLAUDE },
      reviewer: { provider: 'codex', model: FIRST_CODEX },
    });
  });

  it('asks which model each role uses when one agent has several models chosen', async () => {
    const { answer, type } = setup({ roles: ['planner', 'reviewer'] });

    await type(TOGGLE_FIRST, `${SPACE}${DOWN}${SPACE}${ENTER}`, ENTER, `${DOWN}${ENTER}`);

    expect(await answer).toEqual({
      planner: { provider: 'claude', model: FIRST_CLAUDE },
      reviewer: { provider: 'claude', model: SECOND_CLAUDE },
    });
  });

  it('keeps asking until an agent and a model are selected', async () => {
    const { answer, type } = setup({ roles: ['planner'] });

    await type(ENTER, TOGGLE_FIRST, ENTER, TOGGLE_SECOND);

    expect(await answer).toEqual({ planner: { provider: 'claude', model: SECOND_CLAUDE } });
  });

  it('takes a typed model through the free text option', async () => {
    const model = faker.word.noun();
    const { answer, type } = setup({ roles: ['planner'] });

    await type(TOGGLE_FIRST, TOGGLE_LAST, `${model}${ENTER}`);

    expect(await answer).toEqual({ planner: { provider: 'claude', model } });
  });

  it('counts a typed model that was also selected once', async () => {
    const { answer, type } = setup({ roles: ['planner'] });

    await type(TOGGLE_FIRST, `${SPACE}${UP}${SPACE}${ENTER}`, `${FIRST_CLAUDE}${ENTER}`);

    expect(await answer).toEqual({ planner: { provider: 'claude', model: FIRST_CLAUDE } });
  });

  it('goes straight to typing for an agent with no models to offer', async () => {
    const model = `openrouter/${faker.word.noun()}`;
    const { answer, type } = setup({ roles: ['planner'] });

    await type(TOGGLE_SECOND, `${model}${ENTER}`);

    expect(await answer).toEqual({ planner: { provider: 'opencode', model } });
  });

  it('keeps asking until a typed model is not blank', async () => {
    const model = faker.word.noun();
    const { answer, type } = setup({ roles: ['planner'] });

    await type(TOGGLE_FIRST, TOGGLE_LAST, ENTER, `${model}${ENTER}`);

    expect(await answer).toEqual({ planner: { provider: 'claude', model } });
  });

  it('answers nothing when cancelled', async () => {
    const { answer, type } = setup({ roles: ['planner'] });

    await type(CTRL_C);

    expect(await answer).toBeUndefined();
  });

  it.each([
    ['input', { inputIsTTY: false, outputIsTTY: true }],
    ['output', { inputIsTTY: true, outputIsTTY: false }],
  ])('asks nothing when the %s is not a terminal', async (_stream, terminal) => {
    const { answer } = setup({ roles: ['planner'], ...terminal });

    expect(await answer).toBeUndefined();
  });

  function setup(input: { roles: AgentRole[]; inputIsTTY?: boolean; outputIsTTY?: boolean }) {
    const stdin = Object.assign(new PassThrough(), { isTTY: input.inputIsTTY ?? true });
    const stdout = Object.assign(new PassThrough(), { isTTY: input.outputIsTTY ?? true });
    stdout.resume();
    const answer = askForAgents(input.roles, { input: stdin, output: stdout });
    const type = async (...keys: string[]) => {
      for (const key of keys) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        stdin.write(key);
      }
    };
    return { answer, type };
  }
});
