import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';

import { ConfigInvalid, messageOf } from '../domain/errors.js';
import type { ConfigFile } from './load-config.js';

/** Sets the given keys in the config file, keeping every other key as the operator wrote it. */
export async function updateConfigFile(
  { path: file, name }: ConfigFile,
  values: Record<string, unknown>,
): Promise<Result<void, ConfigInvalid>> {
  const current = existsSync(file)
    ? (await onConfigFile(file, () => readFile(file, 'utf-8'))).andThen((contents) =>
        parseConfigObject(name, contents),
      )
    : Result.ok({});
  if (current.isErr()) return Result.err(current.error);
  const contents = `${JSON.stringify({ ...current.value, ...values }, null, 2)}\n`;
  return onConfigFile(file, () => writeFileAtomic(file, contents));
}

function onConfigFile<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<Result<T, ConfigInvalid>> {
  return Result.tryPromise({
    try: operation,
    catch: (cause) =>
      new ConfigInvalid({ message: `Cannot read or write ${file}: ${messageOf(cause)}` }),
  });
}

/** Only an object can take more keys; anything else is left for the operator to fix, not overwritten. */
function parseConfigObject(
  name: string,
  contents: string,
): Result<Record<string, unknown>, ConfigInvalid> {
  const parsed = z.record(z.unknown()).safeParse(parseJson(contents));
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new ConfigInvalid({
          message: `${name} must hold a JSON object to add settings to.`,
        }),
      );
}

function parseJson(contents: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    return undefined;
  }
}
