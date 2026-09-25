import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { advanceRun } from '../../src/orchestrator/advance.js';
import { AutoMergeStrategy } from '../../src/strategies/merge/auto.js';
import { ManualMergeStrategy } from '../../src/strategies/merge/manual.js';
import { checkoutNewBranchAt } from '../../src/git/branch.js';
import { commitAll } from '../../src/git/repository.js';
import { mergeBranchInto } from '../../src/git/merge.js';
import {
  initializeRunState,
  readRunMeta,
  readSlices,
  writeRunMeta,
  writeSlices,
} from '../../src/state/store.js';
import type { Slice } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

function makeSlices(runId: string): Slice[] {
  return [
    {
      id: 'first',
      title: 'First',
      description: 'first',
      order: 0,
      status: 'ready_to_merge',
      branch: `sdlc/slice/${runId}/first`,
      reviewCycles: 0,
      mergeAttempts: 0,
    },
    {
      id: 'second',
      title: 'Second',
      description: 'second',
      order: 1,
      status: 'pending',
      branch: `sdlc/slice/${runId}/second`,
      reviewCycles: 0,
      mergeAttempts: 0,
    },
  ];
}

describe('advanceRun', () => {
  it('auto-merges, marks the slice merged, and advances currentSliceId', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    const slices = makeSlices('run1');
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'first' });
    await checkoutNewBranchAt(repo.dir, slices[0].branch, 'main');
    await writeFile(path.join(repo.dir, 'first.txt'), 'x');
    await commitAll(repo.dir, 'implement first');
    await (await import('../../src/git/branch.js')).checkoutExistingBranch(repo.dir, 'main');

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.currentSliceId).toBe('second');
    expect(result.complete).toBe(false);
    const updatedSlices = await readSlices(paths);
    expect(updatedSlices[0].status).toBe('merged');
  });

  it('detects a manual merge already performed and advances without merging itself', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run2', 'main');
    const slices = makeSlices('run2');
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'first' });
    await checkoutNewBranchAt(repo.dir, slices[0].branch, 'main');
    await writeFile(path.join(repo.dir, 'first.txt'), 'x');
    await commitAll(repo.dir, 'implement first');
    const branchModule = await import('../../src/git/branch.js');
    await branchModule.checkoutExistingBranch(repo.dir, 'main');
    await mergeBranchInto(repo.dir, slices[0].branch, 'main');

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.currentSliceId).toBe('second');
    const updatedSlices = await readSlices(paths);
    expect(updatedSlices[0].status).toBe('merged');
  });

  it('does not advance and reports not advanced when the current slice is not merged yet', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3', 'main');
    const slices = makeSlices('run3').map((s) =>
      s.id === 'first' ? { ...s, status: 'in_review' as const } : s,
    );
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'first' });

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.advanced).toBe(false);
    expect(result.currentSliceId).toBe('first');
  });

  it('reports complete once the last slice is merged', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4', 'main');
    const slice: Slice = {
      id: 'only',
      title: 'Only',
      description: 'only',
      order: 0,
      status: 'ready_to_merge',
      branch: 'sdlc/slice/run4/only',
      reviewCycles: 0,
      mergeAttempts: 0,
    };
    await writeSlices(paths, [slice]);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'only' });
    await checkoutNewBranchAt(repo.dir, slice.branch, 'main');
    await writeFile(path.join(repo.dir, 'only.txt'), 'x');
    await commitAll(repo.dir, 'implement only');
    const branchModule = await import('../../src/git/branch.js');
    await branchModule.checkoutExistingBranch(repo.dir, 'main');

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.complete).toBe(true);
    expect(result.currentSliceId).toBeNull();
  });
});
