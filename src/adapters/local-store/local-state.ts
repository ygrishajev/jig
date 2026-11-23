import { Result } from 'better-result';

import { messageOf } from '../../failures/messages.js';
import { LocalStateUnwritable } from '../../ports/local-state.js';

/** Runs a read or write under `.jig/`, naming the path and the cause when the disk refuses. */
export function onLocalState<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<Result<T, LocalStateUnwritable>> {
  return Result.tryPromise({
    try: operation,
    catch: (cause) =>
      new LocalStateUnwritable({
        message: `Cannot read or write ${file}: ${messageOf(cause)}`,
        path: file,
      }),
  });
}
