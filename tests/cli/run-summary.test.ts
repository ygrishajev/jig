import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { printRunSummary } from '../../src/cli/run-summary.js';
import { checkoutNewBranchAt } from '../../src/git/branch.js';
import { commitAll } from '../../src/git/repository.js';
import {
  initializeRunState,
  readRunMeta,
  writeRunMeta,
  writeSlices,
} from '../../src/state/store.js';
import type { Slice } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
  vi.restoreAllMocks();
});

function makeSlice(runId: string, overrides: Partial<Slice> = {}): Slice {
  return {
    id: 's1',
    title: 'First slice',
    description: 'first',
    order: 0,
    status: 'ready_to_merge',
    branch: `sdlc/slice/${runId}/s1`,
    reviewCycles: 0,
    mergeAttempts: 0,
    ...overrides,
  };
}

describe('printRunSummary', () => {
  it('prints the worktree path and the commits the current slice has over the base branch', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    const slice = makeSlice('run1');
    await writeSlices(paths, [slice]);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 's1' });
    await checkoutNewBranchAt(repo.dir, slice.branch, 'main');
    await writeFile(path.join(repo.dir, 'feature.txt'), 'x');
    await commitAll(repo.dir, 'implement the feature');
    await (await import('../../src/git/branch.js')).checkoutExistingBranch(repo.dir, 'main');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await printRunSummary({ repoRoot: repo.dir, paths, baseBranch: 'main' });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes(`Worktree: ${paths.workspaceDir}`))).toBe(true);
    expect(logged.some((line) => line.includes('Commits on slice branch'))).toBe(true);
    expect(logged.some((line) => line.includes('implement the feature'))).toBe(true);
  });

  it('prints (none) when the slice branch has no commits over the base branch', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run2', 'main');
    const slice = makeSlice('run2');
    await writeSlices(paths, [slice]);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 's1' });
    await checkoutNewBranchAt(repo.dir, slice.branch, 'main');
    await (await import('../../src/git/branch.js')).checkoutExistingBranch(repo.dir, 'main');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await printRunSummary({ repoRoot: repo.dir, paths, baseBranch: 'main' });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('Worktree:'))).toBe(true);
    expect(logged.some((line) => line.trim() === '(none)')).toBe(true);
  });

  it('skips the commit section when the run has no current slice', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3', 'main');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await printRunSummary({ repoRoot: repo.dir, paths, baseBranch: 'main' });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('Worktree:'))).toBe(true);
    expect(logged.some((line) => line.includes('Commits on slice branch'))).toBe(false);
  });
});
