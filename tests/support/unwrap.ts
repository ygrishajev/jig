import type { Result } from 'better-result';

/** The value of an `Ok`; an `Err` fails the test, naming the error. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.isOk()) return result.value;
  throw new Error(`expected an Ok, got an Err: ${String(result.error)}`, { cause: result.error });
}
