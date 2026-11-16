import { Result } from 'better-result';
import { readFile } from 'node:fs/promises';

import { messageOf, RunRequestInvalid } from '../domain/errors.js';

export function readRequest(file: string): Promise<Result<string, RunRequestInvalid>> {
  return Result.tryPromise({
    try: () => readFile(file, 'utf-8'),
    catch: (error) =>
      new RunRequestInvalid({
        message: `Cannot read the request file "${file}": ${messageOf(error)}`,
      }),
  });
}
