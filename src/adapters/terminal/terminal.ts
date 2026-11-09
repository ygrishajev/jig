import { panic } from 'better-result';
import type { Readable, Writable } from 'node:stream';

import { messageOf } from '../../domain/errors.js';

export interface Terminal {
  input: Readable & { isTTY?: boolean };
  output: Writable & { isTTY?: boolean };
}

export const PROCESS_TERMINAL: Terminal = { input: process.stdin, output: process.stdout };

/** What the operator answers; `undefined` when nobody can answer or they cancel. */
export async function askInTerminal<T>(
  terminal: Terminal,
  ask: (terminal: Terminal) => Promise<T>,
): Promise<T | undefined> {
  if (!terminal.input.isTTY || !terminal.output.isTTY) return undefined;
  return ask(terminal).catch((error: unknown) => {
    if (error instanceof Error && error.name === 'ExitPromptError') return undefined;
    panic(messageOf(error), error);
  });
}
