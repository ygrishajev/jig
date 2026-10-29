import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** sdlc's scratch space inside the operator's repository; it ignores itself. */
export const SDLC_DIR = '.sdlc';

export function runDirectory(repoRoot: string, runId: string) {
  return path.join(repoRoot, SDLC_DIR, runId);
}

export function stateDirectory(repoRoot: string, runId: string) {
  return path.join(runDirectory(repoRoot, runId), 'state');
}

export function worktreeDirectory(repoRoot: string, runId: string) {
  return path.join(runDirectory(repoRoot, runId), 'workspace');
}

/** Creates the run's directory under `.sdlc/`, which ignores itself so it never dirties the target repo. */
export async function makeRunDirectory(repoRoot: string, runId: string) {
  const directory = runDirectory(repoRoot, runId);
  await mkdir(directory, { recursive: true });
  const gitignore = path.join(repoRoot, SDLC_DIR, '.gitignore');
  if (!existsSync(gitignore)) await writeFile(gitignore, '*\n');
  return directory;
}
