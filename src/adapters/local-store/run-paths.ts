import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunId } from '../../domain/run-id.js';

/** jig's scratch space inside the operator's repository; it ignores itself. */
export const JIG_DIR = '.jig';

export function runDirectory(repoRoot: string, runId: RunId) {
  return path.join(repoRoot, JIG_DIR, runId);
}

export function stateDirectory(repoRoot: string, runId: RunId) {
  return path.join(runDirectory(repoRoot, runId), 'state');
}

/** Creates the run's directory under `.jig/`, which ignores itself so it never dirties the target repo. */
export async function makeRunDirectory(repoRoot: string, runId: RunId) {
  const directory = runDirectory(repoRoot, runId);
  await mkdir(directory, { recursive: true });
  const gitignore = path.join(repoRoot, JIG_DIR, '.gitignore');
  if (!existsSync(gitignore)) await writeFile(gitignore, '*\n');
  return directory;
}
