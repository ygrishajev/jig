import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { CONFIG_FILE } from './load-config.js';

/** Sets the given keys in `sdlc.config.json`, keeping every other key as the operator wrote it. */
export async function updateConfigFile(repoRoot: string, values: Record<string, unknown>) {
  const file = path.join(repoRoot, CONFIG_FILE);
  const current = existsSync(file)
    ? (JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>)
    : {};
  await writeFileAtomic(file, `${JSON.stringify({ ...current, ...values }, null, 2)}\n`);
}
