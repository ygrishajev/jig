import { afterEach, describe, expect, it } from 'vitest';
import {
  checkoutExistingBranch,
  checkoutNewBranchAt,
  createBranchFrom,
  getCurrentBranch,
  localBranchExists,
} from '../../src/git/branch.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('branch helpers', () => {
  it('reports the current branch', async () => {
    repo = await createTempRepo();
    expect(await getCurrentBranch(repo.dir)).toBe('main');
  });

  it('creates a branch from a ref without checking it out', async () => {
    repo = await createTempRepo();
    await createBranchFrom(repo.dir, 'feature/x', 'main');
    expect(await localBranchExists(repo.dir, 'feature/x')).toBe(true);
    expect(await getCurrentBranch(repo.dir)).toBe('main');
  });

  it('checks out a new branch at a start point', async () => {
    repo = await createTempRepo();
    await checkoutNewBranchAt(repo.dir, 'feature/y', 'main');
    expect(await getCurrentBranch(repo.dir)).toBe('feature/y');
  });

  it('checks out an existing branch', async () => {
    repo = await createTempRepo();
    await createBranchFrom(repo.dir, 'feature/z', 'main');
    await checkoutExistingBranch(repo.dir, 'feature/z');
    expect(await getCurrentBranch(repo.dir)).toBe('feature/z');
  });

  it('reports false for a branch that does not exist', async () => {
    repo = await createTempRepo();
    expect(await localBranchExists(repo.dir, 'nope')).toBe(false);
  });
});
