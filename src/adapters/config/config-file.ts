import { Result } from 'better-result';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';

import {
  type ConfigFile,
  configFrom,
  type JigConfig,
  mayBeAbsent,
} from '../../config/load-config.js';
import { configWithSettings } from '../../config/update-config.js';
import { ConfigInvalid, messageOf } from '../../domain/errors.js';

export function readConfigFile(file: ConfigFile): Result<JigConfig, ConfigInvalid> {
  if (mayBeAbsent(file) && !existsSync(file.path)) return configFrom(file, {});
  return Result.gen(function* () {
    const contents = yield* Result.try({
      try: () => readFileSync(file.path, 'utf-8'),
      catch: (cause) =>
        new ConfigInvalid({ message: `Cannot read ${file.name}: ${messageOf(cause)}` }),
    });
    const json = yield* Result.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) =>
        new ConfigInvalid({ message: `${file.name} is not valid JSON: ${messageOf(cause)}` }),
    });
    return configFrom(file, json);
  });
}

/** Rewrites the whole file atomically, so an interrupted update never leaves half a config. */
export function updateConfigFile(
  file: ConfigFile,
  values: Record<string, unknown>,
): Promise<Result<void, ConfigInvalid>> {
  return Result.gen(async function* () {
    const current = yield* Result.await(currentContents(file));
    const updated = yield* configWithSettings(file, current, values);
    const contents = `${JSON.stringify(updated, null, 2)}\n`;
    return onConfigFile(file, () => writeFileAtomic(file.path, contents));
  });
}

/** A file not written yet holds no settings; one that is not JSON is no object to add to. */
async function currentContents(file: ConfigFile): Promise<Result<unknown, ConfigInvalid>> {
  if (!existsSync(file.path)) return Result.ok({});
  const contents = await onConfigFile(file, () => readFile(file.path, 'utf-8'));
  return contents.map((text) => Result.try((): unknown => JSON.parse(text)).unwrapOr(undefined));
}

function onConfigFile<T>(
  file: ConfigFile,
  operation: () => Promise<T>,
): Promise<Result<T, ConfigInvalid>> {
  return Result.tryPromise({
    try: operation,
    catch: (cause) =>
      new ConfigInvalid({ message: `Cannot read or write ${file.path}: ${messageOf(cause)}` }),
  });
}
