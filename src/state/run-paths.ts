import path from 'node:path';

export interface RunPaths {
  runId: string;
  repoRoot: string;
  stateDir: string;
  workspaceDir: string;
}

export function getRunPaths(repoRoot: string, runId: string): RunPaths {
  return {
    runId,
    repoRoot,
    stateDir: path.join(repoRoot, '.sdlc', runId, 'state'),
    workspaceDir: path.join(repoRoot, '.sdlc', runId, 'workspace'),
  };
}
