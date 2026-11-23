import { panic } from 'better-result';
import { open } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { ReadStream } from 'node:tty';

import { messageOf } from '../../failures/thrown.js';

interface PromptTerminal {
  terminal: Terminal;
  close(): Promise<void>;
}

export interface Terminal {
  input: Readable & { isTTY?: boolean };
  output: Writable & { isTTY?: boolean };
  allowControllingInput?: boolean;
}

export const PROCESS_TERMINAL: Terminal = {
  input: process.stdin,
  output: process.stdout,
  allowControllingInput: true,
};

/** What the operator answers; `undefined` when nobody can answer or they cancel. */
export async function askInTerminal<T>(
  terminal: Terminal,
  ask: (terminal: Terminal) => Promise<T>,
  openTerminal: () => Promise<PromptTerminal | undefined> = openControllingTerminal,
): Promise<T | undefined> {
  if (!terminal.output.isTTY) return undefined;
  const controlling = terminal.input.isTTY
    ? undefined
    : terminal.allowControllingInput
      ? await openTerminal()
      : undefined;
  const interactive = terminal.input.isTTY ? terminal : controlling?.terminal;
  if (!interactive) return undefined;
  try {
    return await ask(interactive).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'ExitPromptError') return undefined;
      panic(messageOf(error), error);
    });
  } finally {
    await controlling?.close();
  }
}

async function openControllingTerminal(): Promise<PromptTerminal | undefined> {
  const handle = await open('/dev/tty', 'r').catch(() => undefined);
  if (!handle) return undefined;
  const input = new ReadStream(handle.fd);
  return {
    terminal: { input, output: process.stdout },
    close: async () => {
      input.destroy();
      await handle.close();
    },
  };
}
