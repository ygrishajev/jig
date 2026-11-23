import type { Result } from 'better-result';

import { messageOf, rootCause } from '../failures/messages.js';

/** Where a failed command reports itself. */
export interface FailureOutput {
  printError(message: string): void;
  setExitCode(code: number): void;
}

/**
 * An expected failure comes back as an `Err` and is printed as its message alone. Anything
 * thrown surfaces as it was first thrown, with its own stack, not the panics wrapped around it.
 */
export function withErrorHandling<Args extends unknown[], E extends { message: string }>(
  fn: (...args: Args) => Promise<Result<void, E>>,
  output: FailureOutput = processFailureOutput,
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      const result = await fn(...args);
      if (result.isErr()) fail(output, result.error.message);
    } catch (error) {
      fail(output, stackOf(rootCause(error)));
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

function stackOf(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : messageOf(error);
}
