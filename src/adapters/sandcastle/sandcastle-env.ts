import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The variables sandcastle injects into every sandbox from `.sandcastle/.env`, beside the
 * credentials jig passes: each key in the file, valued from the file or else the host's
 * environment. Only the names are read, so they can be reported without the values.
 */
export async function sandcastleEnvKeys(repoRoot: string) {
  const content = await readFile(path.join(repoRoot, '.sandcastle', '.env'), 'utf-8').catch(
    () => '',
  );
  return content.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    const separator = trimmed.indexOf('=');
    if (trimmed.startsWith('#') || separator === -1) return [];
    return [trimmed.slice(0, separator).trim()];
  });
}
