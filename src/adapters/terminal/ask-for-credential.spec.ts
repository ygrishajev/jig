import { faker } from '@faker-js/faker';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { codexLogin } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import type { AgentName } from '../../config/agent-policy.js';
import { askForCredential } from './ask-for-credential.js';

const ENTER = '\r';
const DOWN = '\u001B[B';
/** What a terminal's Backspace key sends. */
const BACKSPACE = '\u007F';

/**
 * Readline gives a `dumb` TERM a line editor that inserts every key except Enter, so deletion
 * only works when the fake terminal names a capable type, whatever TERM the test run inherits.
 */
const CAPABLE_TERMINAL_TYPE = 'xterm-256color';

/** The password prompt draws this hint only while idle, so a frame showing it is ready for keys. */
const VISIBILITY_HINT = 'ctrl+t toggle visibility';

type ScreenState = (screen: string) => boolean;

describe('askForCredential', () => {
  it('takes the only credential an agent can use, keeping it off the screen', async () => {
    const value = faker.string.alphanumeric(20);
    const { answer, press, printed } = setup({
      provider: 'opencode',
      keys: ['OPENROUTER_API_KEY'],
    });

    await press(
      [askingFor('OPENROUTER_API_KEY'), value],
      [masked(value.length), ENTER],
      [confirming(), ENTER],
    );

    expect(await answer).toEqual({ name: 'OPENROUTER_API_KEY', value, save: true });
    expect(printed()).not.toContain(value);
  });

  it('asks which credential when the agent accepts several', async () => {
    const value = faker.string.alphanumeric(20);
    const { answer, press } = setup({
      provider: 'claude',
      keys: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    });

    await press(
      [cursorOn('CLAUDE_CODE_OAUTH_TOKEN'), DOWN],
      [cursorOn('ANTHROPIC_API_KEY'), ENTER],
      [askingFor('ANTHROPIC_API_KEY'), value],
      [masked(value.length), ENTER],
      [confirming(), ENTER],
    );

    expect(await answer).toMatchObject({ name: 'ANTHROPIC_API_KEY', value });
  });

  it('saves nothing when the operator declines', async () => {
    const value = faker.string.alphanumeric(20);
    const { answer, press } = setup({ provider: 'opencode', keys: ['OPENROUTER_API_KEY'] });

    await press(
      [askingFor('OPENROUTER_API_KEY'), value],
      [masked(value.length), ENTER],
      [confirming(), 'n'],
      [confirming('n'), ENTER],
    );

    expect(await answer).toMatchObject({ save: false });
  });

  it('keeps asking until a value could be saved safely', async () => {
    const value = faker.string.alphanumeric(20);
    const unsavable = 'bad"value';
    const { answer, press } = setup({ provider: 'opencode', keys: ['OPENROUTER_API_KEY'] });

    await press(
      [askingFor('OPENROUTER_API_KEY'), ENTER],
      [rejectedSecret('Enter a value.'), unsavable],
      [masked(unsavable.length), ENTER],
      [rejectedSecret('cannot hold a quote or a backslash'), BACKSPACE],
      ...shorterPrefixes(unsavable).map((prefix): [ScreenState, string] => [
        masked(prefix.length),
        BACKSPACE,
      ]),
      [masked(0), value],
      [masked(value.length), ENTER],
      [confirming(), ENTER],
    );

    expect(await answer).toMatchObject({ value });
  });

  it('keeps asking until the path holds a Codex login', async () => {
    const empty = await tempDirectory();
    const login = await tempDirectory();
    await writeFile(path.join(login, 'auth.json'), codexLogin());
    const { answer, press, printed } = setup({ provider: 'codex', keys: ['JIG_CODEX_AUTH_DIR'] });

    await press(
      [askingFor('JIG_CODEX_AUTH_DIR'), empty],
      [showing(empty), ENTER],
      [rejected('No Codex login'), BACKSPACE],
      ...shorterPrefixes(empty).map((prefix): [ScreenState, string] => [
        showing(prefix),
        BACKSPACE,
      ]),
      [showing(''), login],
      [showing(login), ENTER],
      [confirming(), ENTER],
    );

    expect(await answer).toMatchObject({ value: login });
    expect(printed()).toContain('No Codex login');
  });

  function setup(missing: { provider: AgentName; keys: string[] }) {
    vi.stubEnv('TERM', CAPABLE_TERMINAL_TYPE);
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = new TerminalScreen();
    let output = '';
    let screen = '';
    stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const visible = stripVTControlCharacters(chunk.toString()).replaceAll('\n', '');
      if (visible) screen = visible;
    });
    const answer = askForCredential(missing, { input: stdin, output: stdout });
    const screenShows = (state: ScreenState) =>
      new Promise<void>((resolve) => {
        const resolveOnceShown = () => {
          if (!state(screen)) return;
          stdout.off('data', resolveOnceShown);
          resolve();
        };
        stdout.on('data', resolveOnceShown);
        resolveOnceShown();
      });
    const press = async (...steps: [ScreenState, string][]) => {
      for (const [state, key] of steps) {
        await screenShows(state);
        stdin.write(key);
      }
    };
    return { answer, press, printed: () => output };
  }
});

/**
 * Stays open across prompts like a real terminal: each prompt ends its output when it finishes,
 * and Node spares only stdio from that, so a plain stream would hide every prompt after the first.
 */
class TerminalScreen extends PassThrough {
  readonly isTTY = true;

  override end() {
    return this;
  }
}

function askingFor(name: string): ScreenState {
  return (screen) => screen.startsWith('? ') && screen.includes(`${name}:`);
}

function cursorOn(name: string): ScreenState {
  return (screen) => screen.includes(`❯ ${name}`);
}

function masked(length: number): ScreenState {
  return (screen) => screen.endsWith(`${afterLabel('*'.repeat(length))}${VISIBILITY_HINT}`);
}

function showing(text: string): ScreenState {
  return (screen) => screen.startsWith('? ') && screen.endsWith(afterLabel(text));
}

function confirming(answer = ''): ScreenState {
  return (screen) => screen.startsWith('? ') && screen.endsWith(`(Y/n)${answer && ` ${answer}`}`);
}

function rejected(problem: string): ScreenState {
  return (screen) => screen.includes(problem);
}

/** A rejected secret, once idle: its error frame is first drawn while the prompt is still loading. */
function rejectedSecret(problem: string): ScreenState {
  return (screen) => rejected(problem)(screen) && screen.endsWith(VISIBILITY_HINT);
}

function afterLabel(value: string) {
  return value ? `: ${value}` : ':';
}

function shorterPrefixes(text: string) {
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(0, -index - 1));
}
