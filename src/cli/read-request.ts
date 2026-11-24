import { Result } from 'better-result';
import path from 'node:path';

import type { RequestInputs, StandardInput } from '../adapters/terminal/standard-input.js';
import type { StartRequest } from '../app/api.js';
import { RunRequestInvalid } from '../app/errors.js';
import { messageOf } from '../failures/messages.js';

/** Where a request comes from: a file, or text piped to standard input. */
export type RequestSource = { file: string } | { stdin: true };

export async function readRequest(
  source: RequestSource,
  inputs: RequestInputs,
): Promise<Result<StartRequest, RunRequestInvalid>> {
  if ('stdin' in source) {
    const piped = await readPipedText(inputs.standardInput());
    return piped.andThen((text) => nonBlank({ text }, 'standard input'));
  }
  const file = path.resolve(inputs.cwd(), source.file);
  const text = await Result.tryPromise({
    try: () => inputs.readTextFile(file),
    catch: (error) =>
      new RunRequestInvalid({
        message: `Cannot read the request file "${file}": ${messageOf(error)}`,
      }),
  });
  return text.andThen((read) => nonBlank({ text: read, file: source.file }, `"${file}"`));
}

async function readPipedText(
  standardInput: StandardInput,
): Promise<Result<string, RunRequestInvalid>> {
  if (standardInput.isTerminal) {
    return Result.err(
      new RunRequestInvalid({
        message:
          'Cannot read the request from standard input: it is a terminal. Pipe the request in, for example: cat request.md | jig run -',
      }),
    );
  }
  return Result.tryPromise({
    try: () => standardInput.readAll(),
    catch: (error) =>
      new RunRequestInvalid({
        message: `Cannot read the request from standard input: ${messageOf(error)}`,
      }),
  });
}

function nonBlank(request: StartRequest, origin: string): Result<StartRequest, RunRequestInvalid> {
  if (request.text.trim() !== '') return Result.ok(request);
  return Result.err(
    new RunRequestInvalid({ message: `The request is empty: ${origin} has no text.` }),
  );
}
