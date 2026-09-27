import { realpathSync } from 'node:fs';
import { openRepo } from './repository.js';

export async function addWorktreeForNewBranch(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  fromRef: string,
  options?: { skipCommitSigning?: boolean },
): Promise<void> {
  await openRepo(repoRoot).raw(['worktree', 'add', '-b', branchName, worktreePath, fromRef]);
  if (options?.skipCommitSigning) await disableCommitSigningInWorktree(repoRoot, worktreePath);
}

export async function addWorktreeForExistingBranch(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  options?: { skipCommitSigning?: boolean },
): Promise<void> {
  await openRepo(repoRoot).raw(['worktree', 'add', worktreePath, branchName]);
  if (options?.skipCommitSigning) await disableCommitSigningInWorktree(repoRoot, worktreePath);
}

/**
 * Slice worktree commits are made inside a sandbox container that cannot reach
 * the host's signing setup (e.g. 1Password's agent) — a signing attempt aborts
 * the commit outright. Disables signing for this worktree only, via
 * git's per-worktree config, so the operator's own repos keep signing.
 */
async function disableCommitSigningInWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  await openRepo(repoRoot).raw(['config', 'extensions.worktreeConfig', 'true']);
  await openRepo(worktreePath).raw(['config', '--worktree', 'commit.gpgsign', 'false']);
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await openRepo(repoRoot).raw(['worktree', 'remove', worktreePath, '--force']);
}

export async function worktreeExists(repoRoot: string, worktreePath: string): Promise<boolean> {
  const list = await openRepo(repoRoot).raw(['worktree', 'list', '--porcelain']);
  let canonicalWorktreePath: string;
  try {
    canonicalWorktreePath = realpathSync(worktreePath);
  } catch {
    canonicalWorktreePath = worktreePath;
  }
  return list.split('\n').some((line) => {
    if (!line.startsWith('worktree ')) return false;
    const listedPath = line.slice(9);
    let canonicalListedPath: string;
    try {
      canonicalListedPath = realpathSync(listedPath);
    } catch {
      canonicalListedPath = listedPath;
    }
    return canonicalListedPath === canonicalWorktreePath;
  });
}
