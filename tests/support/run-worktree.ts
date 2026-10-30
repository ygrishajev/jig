import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { RunId } from '../../src/domain/run-id.js';
import { runBranchFor } from '../../src/domain/run-state.js';
import { createTempRepo, type TempRepo } from './temp-repo.js';

export interface RunWorktree {
  repo: TempRepo;
  worktreePath: string;
  runBranch: string;
  git: ReturnType<typeof simpleGit>;
  cleanup: () => Promise<void>;
}

/** A real repository with a run branch checked out in its own worktree, the way a run sees it. */
export async function createRunWorktree(runId: RunId): Promise<RunWorktree> {
  const repo = await createTempRepo();
  const worktreePath = path.join(repo.dir, '.sdlc', runId, 'workspace');
  const runBranch = runBranchFor(runId);
  const git = simpleGit({ baseDir: repo.dir });
  await git.raw(['worktree', 'add', '-b', runBranch, worktreePath, 'main']);
  return {
    repo,
    worktreePath,
    runBranch,
    git,
    cleanup: repo.cleanup,
  };
}
