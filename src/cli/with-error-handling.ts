import { messageOf } from '../domain/errors.js';

/** Where a failed command reports itself. */
export interface FailureOutput {
  printError(message: string): void;
  setExitCode(code: number): void;
}

/** Sets `exitCode` rather than calling `process.exit()`, so pending output still flushes. */
const processFailureOutput: FailureOutput = {
  printError: (message) => console.error(message),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export function withErrorHandling<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
  output: FailureOutput = processFailureOutput,
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      output.printError(messageOf(error));
      output.setExitCode(1);
    }
  };
}
