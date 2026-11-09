import { faker } from '@faker-js/faker';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { codexLogin } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import type { MissingCredential } from '../sandcastle/agents.js';
import { askForCredential } from './ask-for-credential.js';

const ENTER = '\r';
const DOWN = '\u001B[B';

describe('askForCredential', () => {
  it('takes the only credential an agent can use, keeping it off the screen', async () => {
    const value = faker.string.alphanumeric(20);
    const { answer, type, printed } = setup({ provider: 'opencode', keys: ['OPENROUTER_API_KEY'] });

    await type(`${value}${ENTER}`, ENTER);

    expect(await answer).toEqual({ name: 'OPENROUTER_API_KEY', value, save: true });
    expect(printed()).not.toContain(value);
  });

  it('asks which credential when the agent accepts several', async () => {
    const value = faker.string.alphanumeric(20);
    const { answer, type } = setup({
      provider: 'claude',
      keys: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    });

    await type(`${DOWN}${ENTER}`, `${value}${ENTER}`, ENTER);

    expect(await answer).toMatchObject({ name: 'ANTHROPIC_API_KEY', value });
  });

  it('saves nothing when the operator declines', async () => {
    const { answer, type } = setup({ provider: 'opencode', keys: ['OPENROUTER_API_KEY'] });

    await type(`${faker.string.alphanumeric(20)}${ENTER}`, `n${ENTER}`);

    expect(await answer).toMatchObject({ save: false });
  });

  it('keeps asking until a value could be saved safely', async () => {
    const value = faker.string.alphanumeric(20);
    const { answer, type } = setup({ provider: 'opencode', keys: ['OPENROUTER_API_KEY'] });

    await type(ENTER, `bad"value${ENTER}`);
    await type(...Array.from({ length: 9 }, () => '\u007F'), `${value}${ENTER}`, ENTER);

    expect(await answer).toMatchObject({ value });
  });

  it('keeps asking until the path holds a Codex login', async () => {
    const empty = await tempDirectory();
    const login = await tempDirectory();
    await writeFile(path.join(login, 'auth.json'), codexLogin());
    const { answer, type, printed } = setup({ provider: 'codex', keys: ['JIG_CODEX_AUTH_DIR'] });

    await type(`${empty}${ENTER}`);
    await type(...Array.from(empty, () => '\u007F'), `${login}${ENTER}`, ENTER);

    expect(await answer).toMatchObject({ value: login });
    expect(printed()).toContain('No Codex login');
  });

  function setup(missing: MissingCredential) {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = Object.assign(new PassThrough(), { isTTY: true });
    let output = '';
    stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const answer = askForCredential(missing, { input: stdin, output: stdout });
    const type = async (...keys: string[]) => {
      for (const key of keys) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        stdin.write(key);
      }
    };
    return { answer, type, printed: () => output };
  }
});
