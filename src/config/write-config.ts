import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';
import { ConfigInvalid } from '../domain/errors.js';
import { CONFIG_FILE } from './load-config.js';

/** Sets the given keys in `sdlc.config.json`, keeping every other key as the operator wrote it. */
export async function updateConfigFile(repoRoot: string, values: Record<string, unknown>) {
  const file = path.join(repoRoot, CONFIG_FILE);
  const current = existsSync(file) ? parseConfigObject(await readFile(file, 'utf-8')) : {};
  await writeFileAtomic(file, `${JSON.stringify({ ...current, ...values }, null, 2)}\n`);
}

/** Only an object can take more keys; anything else is left for the operator to fix, not overwritten. */
function parseConfigObject(contents: string) {
  const parsed = z.record(z.unknown()).safeParse(parseJson(contents));
  if (!parsed.success) {
    throw new ConfigInvalid(`${CONFIG_FILE} must hold a JSON object to add settings to.`);
  }
  return parsed.data;
}

function parseJson(contents: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    return undefined;
  }
}
