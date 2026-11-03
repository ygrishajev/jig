import type { Result } from 'better-result';

import { type JigError, messageOf } from '../domain/errors.js';

/** Where a failed command reports itself. */
export interface FailureOutput {
  printError(message: string): void;
  setExitCode(code: number): void;
}

/**
 * An expected failure comes back as an `Err` and is printed as its message alone. Anything
 * thrown is a bug in jig, or a third-party throw nobody wrapped, and is printed with its stack.
 */
export function withErrorHandling<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Result<void, JigError>>,
  output: FailureOutput = processFailureOutput,
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      const result = await fn(...args);
      if (result.isErr()) fail(output, result.error.message);
    } catch (error) {
      fail(output, `${BUG_NOTICE}\n${stackOf(error)}`);
    }
  };
}

/** Sets `exitCode` rather than calling `process.exit()`, so pending output still flushes. */
const processFailureOutput: FailureOutput = {
  printError: (message) => console.error(message),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

function fail(output: FailureOutput, message: string): void {
  output.printError(message);
  output.setExitCode(1);
}

const BUG_NOTICE =
  'jig hit an internal error — this is a bug in jig, not in your setup. Please report it with the details below.';

function stackOf(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : messageOf(error);
}
