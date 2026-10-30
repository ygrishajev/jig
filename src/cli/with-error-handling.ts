import { messageOf } from '../domain/errors.js';

/** Sets `exitCode` rather than calling `process.exit()`, so pending output still flushes. */
export function withErrorHandling<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(messageOf(error));
      process.exitCode = 1;
    }
  };
}
