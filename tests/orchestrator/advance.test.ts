import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('logs which slice was merged into which base branch', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'runlog', 'main');
    const slices = makeSlices('runlog');
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'first' });
    await checkoutNewBranchAt(repo.dir, slices[0].branch, 'main');
    await writeFile(path.join(repo.dir, 'first.txt'), 'x');
    await commitAll(repo.dir, 'implement first');
    await (await import('../../src/git/branch.js')).checkoutExistingBranch(repo.dir, 'main');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('[sdlc runlog]'))).toBe(true);
    expect(logged.some((line) => line.includes('slice "first" merged into "main"'))).toBe(true);
  });

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
    expect(result.complete).toBe(false);
  });

  it('reports not advanced without attempting a merge when the current slice is not ready to merge', async () => {
    // Guards against auto-merging a slice that is still mid-flight: only a
    // slice whose status is exactly 'ready_to_merge' should ever reach
    // mergeStrategy.merge(). Uses AutoMergeStrategy (unlike the manual-mode
    // test above) so an incorrect merge attempt would actually try to run
    // `git merge` on a branch that was never created and fail loudly.
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3b', 'main');
    const slices = makeSlices('run3b').map((s) =>
      s.id === 'first' ? { ...s, status: 'in_review' as const } : s,
    );
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'first' });

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.advanced).toBe(false);
    expect(result.complete).toBe(false);
    const updatedSlices = await readSlices(paths);
    expect(updatedSlices[0].status).toBe('in_review');
  });

  it('reports not advanced with complete based on remaining slices when the current slice id matches nothing', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3c', 'main');
    const slices = makeSlices('run3c');
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    // No slice has this id — simulates calling merge/advance after the run's
    // currentSliceId has already gone stale or was never set for these slices.
    await writeRunMeta(paths, { ...meta, currentSliceId: 'does-not-exist' });

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.advanced).toBe(false);
    expect(result.currentSliceId).toBe('does-not-exist');
    expect(result.complete).toBe(true);
  });

  it('reports not complete when there is no current slice and no slices exist at all', async () => {
    // Distinguishes `slices.length > 0` from always-true and from `>= 0`
    // (which is also always true): with zero slices, complete must be false.
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3f', 'main');
    await writeSlices(paths, []);

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.advanced).toBe(false);
    expect(result.complete).toBe(false);
  });

  it('targets the slice matching currentSliceId even when it is not first in the array', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3d', 'main');
    // 'first' (order 0, status 'ready_to_merge' but never actually merged)
    // appears before 'second' in the array, but currentSliceId points at
    // 'second', which is the one with real commits to merge. A find() that
    // ignored the id and always matched the first element would instead try
    // to merge 'first's nonexistent commits and fail, rather than advancing
    // 'second'.
    const slices = makeSlices('run3d');
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'second' });
    await checkoutNewBranchAt(repo.dir, slices[1].branch, 'main');
    await writeFile(path.join(repo.dir, 'second.txt'), 'x');
    await commitAll(repo.dir, 'implement second');
    await (await import('../../src/git/branch.js')).checkoutExistingBranch(repo.dir, 'main');
    await mergeBranchInto(repo.dir, slices[1].branch, 'main');

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.advanced).toBe(true);
    const updatedSlices = await readSlices(paths);
    expect(updatedSlices.find((s) => s.id === 'second')?.status).toBe('merged');
    expect(updatedSlices.find((s) => s.id === 'first')?.status).toBe('ready_to_merge');
  });

  it('picks the next slice by order, not array position, when multiple slices remain', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3e', 'main');
    // Array position deliberately disagrees with `order`: the slice that
    // should come next ('low-order') is listed *after* the one that should
    // come later ('high-order'). Only a real sort by `order` picks correctly.
    const slices: Slice[] = [
      {
        id: 'current',
        title: 'Current',
        description: 'current',
        order: 0,
        status: 'ready_to_merge',
        branch: 'sdlc/slice/run3e/current',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'high-order',
        title: 'High order',
        description: 'high',
        order: 2,
        status: 'pending',
        branch: 'sdlc/slice/run3e/high-order',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'low-order',
        title: 'Low order',
        description: 'low',
        order: 1,
        status: 'pending',
        branch: 'sdlc/slice/run3e/low-order',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ];
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'current' });
    await checkoutNewBranchAt(repo.dir, slices[0].branch, 'main');
    await writeFile(path.join(repo.dir, 'current.txt'), 'x');
    await commitAll(repo.dir, 'implement current');
    await (await import('../../src/git/branch.js')).checkoutExistingBranch(repo.dir, 'main');

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.currentSliceId).toBe('low-order');
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
