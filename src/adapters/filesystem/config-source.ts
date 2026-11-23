import { Result } from 'better-result';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

import {
  type ConfigContents,
  ConfigNotJson,
  type ConfigSource,
  ConfigUnreadable,
  ConfigUnwritable,
} from '../../config/config-source.js';
import { messageOf } from '../exception-details.js';

/** The file a command's settings live in, as the operator named it and where it resolves. */
export interface ConfigDestination {
  path: string;
  name: string;
  custom: boolean;
}

/** A custom destination resolves against the repository root, where every command starts. */
export function configDestination(repoRoot: string, customPath?: string): ConfigDestination {
  return customPath === undefined
    ? { path: path.join(repoRoot, CONFIG_FILE), name: CONFIG_FILE, custom: false }
    : { path: path.resolve(repoRoot, customPath), name: customPath, custom: true };
}

/** The repository's own settings file, which `jig init` starts and the operator commits. */
const CONFIG_FILE = 'jig.config.json';

export function configFileSource(destination: ConfigDestination): ConfigSource {
  return {
    name: destination.name,
    custom: destination.custom,
    read: () => readDestination(destination),
    write: (settings) => writeDestination(destination, settings),
  };
}

function readDestination(
  destination: ConfigDestination,
): Result<ConfigContents, ConfigUnreadable | ConfigNotJson> {
  const text = Result.try({
    try: () => readFileSync(destination.path, 'utf-8'),
    catch: messageOf,
  });
  if (text.isErr()) return nothingReadableAt(destination, text.error);
  return Result.try({
    try: (): unknown => JSON.parse(text.value),
    catch: (cause) => new ConfigNotJson({ detail: messageOf(cause) }),
  }).map((json): ConfigContents => ({ kind: 'present', json }));
}

/** Anything `existsSync` cannot see, a dangling link or an unreachable directory included, is absent. */
function nothingReadableAt(
  destination: ConfigDestination,
  detail: string,
): Result<ConfigContents, ConfigUnreadable> {
  return existsSync(destination.path)
    ? Result.err(new ConfigUnreadable({ location: destination.path, detail }))
    : Result.ok({ kind: 'absent', detail });
}

/** Rewrites the whole file atomically, so an interrupted update never leaves half a config. */
function writeDestination(
  destination: ConfigDestination,
  settings: Record<string, unknown>,
): Promise<Result<void, ConfigUnwritable>> {
  return Result.tryPromise({
    try: () => writeFileAtomic(destination.path, `${JSON.stringify(settings, null, 2)}\n`),
    catch: (cause) =>
      new ConfigUnwritable({ location: destination.path, detail: messageOf(cause) }),
  });
}
