import { simpleGit } from 'simple-git';

import { GitWorkspace } from '../../src/adapters/git/git-workspace.js';
import type { RunId } from '../../src/domain/run-id.js';
import { runBranchFor } from '../../src/domain/run-state.js';
import { FakeAgentSession } from './fakes.js';
import { openRunWorktree } from './open-run-worktree.js';
import { createTempRepo } from './temp-repo.js';

/**
 * A real repository with a run branch in its own worktree, the way a run sees it, a real clone
 * standing in for the sandbox's, and the run's workspace on both.
 */
export async function createRunWorktree(runId: RunId) {
  const repo = await createTempRepo();
  const { worktreePath, sandboxPath } = await openRunWorktree({
    repoRoot: repo.dir,
    runId,
    baseBranch: 'main',
  });
  const runBranch = runBranchFor(runId);
  const git = simpleGit({ baseDir: repo.dir });
  const agent = new FakeAgentSession(sandboxPath);
  const workspace = new GitWorkspace({
    repoRoot: repo.dir,
    worktreePath,
    runId,
    baseBranch: 'main',
    sandbox: agent,
  });
  const inSandbox = simpleGit({ baseDir: sandboxPath });
  return { repo, worktreePath, sandboxPath, runBranch, git, inSandbox, agent, workspace };
}
