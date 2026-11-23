import { Panic } from 'better-result';

/** JavaScript can throw anything, not only an `Error`. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What was first thrown under a chain of panics, such as the one `Result.gen` wraps around a throw. */
export function rootCause(error: unknown): unknown {
  let cause = error;
  while (Panic.is(cause) && cause.cause !== undefined) cause = cause.cause;
  return cause;
}
