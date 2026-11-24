import { readFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';

/** Where a command's request text comes from; each is read only once the command needs it. */
export interface RequestInputs {
  cwd(): string;
  standardInput(): StandardInput;
  /** Rejects as `fs.readFile` does when the file cannot be read. */
  readTextFile(file: string): Promise<string>;
}

/** What the CLI reads piped in from the shell; a terminal has nothing piped to read. */
export interface StandardInput {
  isTerminal: boolean;
  readAll(): Promise<string>;
}

export function processRequestInputs(): RequestInputs {
  return {
    cwd: () => process.cwd(),
    standardInput: processStandardInput,
    readTextFile: (file) => readFile(file, 'utf-8'),
  };
}

export function processStandardInput(): StandardInput {
  return {
    isTerminal: process.stdin.isTTY === true,
    readAll: () => text(process.stdin),
  };
}
