import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  addWorktreeForExistingBranch,
  addWorktreeForNewBranch,
  removeWorktree,
  worktreeExists,
} from '../../src/git/worktree.js';
import { createBranchFrom } from '../../src/git/branch.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('worktree helpers', () => {
  it('adds a worktree for a new branch', async () => {
    repo = await createTempRepo();
    const wt = path.join(repo.dir, '.wt', 'a');
    await addWorktreeForNewBranch(repo.dir, wt, 'feature/a', 'main');
    expect(existsSync(wt)).toBe(true);
    expect(await worktreeExists(repo.dir, wt)).toBe(true);
  });

  it('adds a worktree for an existing branch', async () => {
    repo = await createTempRepo();
    await createBranchFrom(repo.dir, 'feature/b', 'main');
    const wt = path.join(repo.dir, '.wt', 'b');
    await addWorktreeForExistingBranch(repo.dir, wt, 'feature/b');
    expect(existsSync(wt)).toBe(true);
  });

  it('removes a worktree', async () => {
    repo = await createTempRepo();
    const wt = path.join(repo.dir, '.wt', 'c');
    await addWorktreeForNewBranch(repo.dir, wt, 'feature/c', 'main');
    await removeWorktree(repo.dir, wt);
    expect(existsSync(wt)).toBe(false);
    expect(await worktreeExists(repo.dir, wt)).toBe(false);
  });

  it('reports false for a path with no worktree', async () => {
    repo = await createTempRepo();
    expect(await worktreeExists(repo.dir, path.join(repo.dir, '.wt', 'nope'))).toBe(false);
  });
});
