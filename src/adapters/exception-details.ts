import { Panic } from 'better-result';

import type { ExceptionDetails } from '../ports/exception-details.js';

export const exceptionDetails: ExceptionDetails = { messageOf, rootCause };

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** better-result wraps a throw in a `Panic` but has no helper that unwraps a chain of them. */
export function rootCause(error: unknown): unknown {
  let cause = error;
  while (Panic.is(cause) && cause.cause !== undefined) cause = cause.cause;
  return cause;
}
