import { readFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';

import type { RequestInputs, StandardInput } from '../../ports/request-inputs.js';

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
