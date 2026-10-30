import path from 'node:path';
import { simpleGit } from 'simple-git';
import { GitWorkspace } from '../../src/adapters/git/git-workspace.js';
import type { RunId } from '../../src/domain/run-id.js';
import { runBranchFor } from '../../src/domain/run-state.js';
import { createTempRepo } from './temp-repo.js';

/**
 * A real repository with a run branch checked out in its own worktree, the way a run sees it,
 * and the run's workspace on it; removed once the test that asked for it finishes.
 */
export async function createRunWorktree(runId: RunId) {
  const repo = await createTempRepo();
  const worktreePath = path.join(repo.dir, '.sdlc', runId, 'workspace');
  const runBranch = runBranchFor(runId);
  const git = simpleGit({ baseDir: repo.dir });
  await git.raw(['worktree', 'add', '-b', runBranch, worktreePath, 'main']);
  const workspace = new GitWorkspace({
    repoRoot: repo.dir,
    worktreePath,
    runId,
    baseBranch: 'main',
  });
  return { repo, worktreePath, runBranch, git, workspace };
}
