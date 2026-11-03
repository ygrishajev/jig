import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';

import { ConfigInvalid } from '../domain/errors.js';
import { CONFIG_FILE } from './load-config.js';

/** Sets the given keys in `jig.config.json`, keeping every other key as the operator wrote it. */
export async function updateConfigFile(
  repoRoot: string,
  values: Record<string, unknown>,
): Promise<Result<void, ConfigInvalid>> {
  const file = path.join(repoRoot, CONFIG_FILE);
  const current = existsSync(file)
    ? parseConfigObject(await readFile(file, 'utf-8'))
    : Result.ok({});
  if (current.isErr()) return Result.err(current.error);
  await writeFileAtomic(file, `${JSON.stringify({ ...current.value, ...values }, null, 2)}\n`);
  return Result.ok();
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
