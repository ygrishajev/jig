import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';

import { ConfigInvalid, messageOf } from '../domain/errors.js';
import { CONFIG_FILE } from './load-config.js';

/** Sets the given keys in `jig.config.json`, keeping every other key as the operator wrote it. */
export async function updateConfigFile(
  repoRoot: string,
  values: Record<string, unknown>,
): Promise<Result<void, ConfigInvalid>> {
  const file = path.join(repoRoot, CONFIG_FILE);
  const current = existsSync(file)
    ? (await onConfigFile(file, () => readFile(file, 'utf-8'))).andThen(parseConfigObject)
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
function parseConfigObject(contents: string): Result<Record<string, unknown>, ConfigInvalid> {
  const parsed = z.record(z.unknown()).safeParse(parseJson(contents));
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new ConfigInvalid({
          message: `${CONFIG_FILE} must hold a JSON object to add settings to.`,
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
