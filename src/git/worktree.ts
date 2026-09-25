import { realpathSync } from 'node:fs';
import { openRepo } from './repository.js';

export async function addWorktreeForNewBranch(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  fromRef: string,
): Promise<void> {
  await openRepo(repoRoot).raw(['worktree', 'add', '-b', branchName, worktreePath, fromRef]);
}

export async function addWorktreeForExistingBranch(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  await openRepo(repoRoot).raw(['worktree', 'add', worktreePath, branchName]);
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
