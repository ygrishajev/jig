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
