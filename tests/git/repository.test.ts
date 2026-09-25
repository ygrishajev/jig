import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commitAll, isWorkingTreeClean } from '../../src/git/repository.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('isWorkingTreeClean', () => {
  it('is true right after a commit', async () => {
    repo = await createTempRepo();
    expect(await isWorkingTreeClean(repo.dir)).toBe(true);
  });

  it('is false with an untracked file', async () => {
    repo = await createTempRepo();
    await writeFile(path.join(repo.dir, 'new.txt'), 'hi');
    expect(await isWorkingTreeClean(repo.dir)).toBe(false);
  });
});

describe('commitAll', () => {
  it('commits pending changes and returns the sha', async () => {
    repo = await createTempRepo();
    await writeFile(path.join(repo.dir, 'new.txt'), 'hi');
    const sha = await commitAll(repo.dir, 'add new.txt');
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await isWorkingTreeClean(repo.dir)).toBe(true);
  });

  it('returns null when there is nothing to commit', async () => {
    repo = await createTempRepo();
    expect(await commitAll(repo.dir, 'noop')).toBeNull();
  });
});
