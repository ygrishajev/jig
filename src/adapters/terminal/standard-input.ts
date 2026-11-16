import { text } from 'node:stream/consumers';

/** What the CLI reads piped in from the shell; a terminal has nothing piped to read. */
export interface StandardInput {
  isTerminal: boolean;
  readAll(): Promise<string>;
}

export function processStandardInput(): StandardInput {
  return {
    isTerminal: process.stdin.isTTY === true,
    readAll: () => text(process.stdin),
  };
}
