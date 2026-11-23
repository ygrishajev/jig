import { Result } from 'better-result';

import { LocalStateUnwritable } from '../../ports/filesystem.js';
import { messageOf } from '../exception-details.js';

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
