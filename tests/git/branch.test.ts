import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentBranch } from '../../src/git/branch.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('getCurrentBranch', () => {
  it('reports the current branch', async () => {
    repo = await createTempRepo();
    expect(await getCurrentBranch(repo.dir)).toBe('main');
  });
});
