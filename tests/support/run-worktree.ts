import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
    signing: 'skip',
  });
  const inSandbox = simpleGit({ baseDir: sandboxPath });
  /** Installs a commit-msg hook in the sandbox's clone that refuses every commit, printing `output`. */
  const rejectCommitsInSandbox = async (output: string) => {
    const hooks = path.resolve(sandboxPath, await inSandbox.revparse(['--git-path', 'hooks']));
    const hook = path.join(hooks, 'commit-msg');
    await writeFile(hook, `#!/bin/sh\necho '${output}' >&2\nexit 1\n`);
    await chmod(hook, 0o755);
  };
  return {
    repo,
    worktreePath,
    sandboxPath,
    runBranch,
    git,
    inSandbox,
    agent,
    workspace,
    rejectCommitsInSandbox,
  };
}
