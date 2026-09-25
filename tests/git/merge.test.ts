import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isBranchMergedInto, mergeBranchInto } from '../../src/git/merge.js';
import { checkoutNewBranchAt, checkoutExistingBranch } from '../../src/git/branch.js';
import { commitAll } from '../../src/git/repository.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('mergeBranchInto and isBranchMergedInto', () => {
  it('merges a clean branch and reports it as merged', async () => {
    repo = await createTempRepo();
    await checkoutNewBranchAt(repo.dir, 'feature/m', 'main');
    await writeFile(path.join(repo.dir, 'm.txt'), 'hi');
    await commitAll(repo.dir, 'add m.txt');
    await checkoutExistingBranch(repo.dir, 'main');
    expect(await isBranchMergedInto(repo.dir, 'feature/m', 'main')).toBe(false);
    const sha = await mergeBranchInto(repo.dir, 'feature/m', 'main');
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await isBranchMergedInto(repo.dir, 'feature/m', 'main')).toBe(true);
  });

  it('refuses to merge when the target branch is not checked out', async () => {
    repo = await createTempRepo();
    await checkoutNewBranchAt(repo.dir, 'feature/n', 'main');
    await writeFile(path.join(repo.dir, 'n.txt'), 'hi');
    await commitAll(repo.dir, 'add n.txt');
    await expect(mergeBranchInto(repo.dir, 'feature/n', 'main')).rejects.toThrow(/not checked out/);
  });

  it('refuses to merge with a dirty working tree', async () => {
    repo = await createTempRepo();
    await checkoutNewBranchAt(repo.dir, 'feature/o', 'main');
    await writeFile(path.join(repo.dir, 'o.txt'), 'hi');
    await commitAll(repo.dir, 'add o.txt');
    await checkoutExistingBranch(repo.dir, 'main');
    await writeFile(path.join(repo.dir, 'dirty.txt'), 'uncommitted');
    await expect(mergeBranchInto(repo.dir, 'feature/o', 'main')).rejects.toThrow(
      /uncommitted changes/,
    );
  });

  it('throws a plain git error when the branches actually conflict', async () => {
    repo = await createTempRepo();
    await checkoutNewBranchAt(repo.dir, 'feature/p', 'main');
    await writeFile(path.join(repo.dir, 'README.md'), 'from branch\n');
    await commitAll(repo.dir, 'change readme on branch');
    await checkoutExistingBranch(repo.dir, 'main');
    await writeFile(path.join(repo.dir, 'README.md'), 'from main\n');
    await commitAll(repo.dir, 'change readme on main');
    await expect(mergeBranchInto(repo.dir, 'feature/p', 'main')).rejects.toThrow();
  });

  it('returns false for a non-existent branch', async () => {
    repo = await createTempRepo();
    expect(await isBranchMergedInto(repo.dir, 'does-not-exist', 'main')).toBe(false);
  });
});
