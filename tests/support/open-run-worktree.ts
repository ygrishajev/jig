import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { runDirectory } from '../../src/adapters/local-store/run-paths.js';
import type { RunId } from '../../src/domain/run-id.js';
import { runBranchFor } from '../../src/domain/run-state.js';

export interface RunWorktreeOptions {
  repoRoot: string;
  runId: RunId;
  baseBranch: string;
}

/** Where a fake sandbox keeps its clone of a run. */
export function sandboxCloneOf(repoRoot: string, runId: RunId): string {
  return path.join(runDirectory(repoRoot, runId), 'sandbox');
}

/**
 * Stands in for sandcastle's worktree and the provider's clone in tests: makes sure the run's host
 * worktree exists with the run branch checked out, and gives the sandbox a fresh clone of it.
 */
export async function openRunWorktree({ repoRoot, runId, baseBranch }: RunWorktreeOptions) {
  const worktreePath = path.join(runDirectory(repoRoot, runId), 'workspace');
  const branch = runBranchFor(runId);
  const repo = simpleGit({ baseDir: repoRoot });

  if (!existsSync(worktreePath)) {
    await repo.raw(['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
  } else {
    const worktree = simpleGit({ baseDir: worktreePath });
    if ((await repo.branchLocal()).all.includes(branch)) await worktree.checkout(branch);
    else await worktree.checkoutBranch(branch, baseBranch);
  }
  const sandboxPath = sandboxCloneOf(repoRoot, runId);
  await rm(sandboxPath, { recursive: true, force: true });
  await cloneForSandbox({ repoRoot, branch, baseBranch, sandboxPath });
  return { worktreePath, sandboxPath };
}

async function cloneForSandbox(input: {
  repoRoot: string;
  branch: string;
  baseBranch: string;
  sandboxPath: string;
}) {
  await simpleGit().clone(input.repoRoot, input.sandboxPath, ['-q', '-b', input.branch]);
  const sandbox = simpleGit({ baseDir: input.sandboxPath });
  await sandbox.raw(['branch', input.baseBranch, `origin/${input.baseBranch}`]);
  await sandbox.addConfig('user.name', 'jig');
  await sandbox.addConfig('user.email', 'jig@users.noreply.invalid');
}
