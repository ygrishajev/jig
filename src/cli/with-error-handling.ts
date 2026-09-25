/**
 * Wraps a commander `.action()` callback so a thrown or rejected error
 * becomes a clean one-line message on stderr with a non-zero exit code,
 * instead of a raw Node stack trace from an unhandled rejection.
 *
 * Deliberately does not call `process.exit()` — setting `process.exitCode`
 * lets the process finish naturally (any pending I/O flushes) while still
 * exiting non-zero once the event loop drains.
 */
export function withErrorHandling<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    }
  };
}
