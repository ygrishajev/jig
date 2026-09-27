import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { runReconcilerPass } from '../../src/orchestrator/reconcile.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { AutoMergeStrategy } from '../../src/strategies/merge/auto.js';
import { ManualMergeStrategy } from '../../src/strategies/merge/manual.js';
import { checkoutExistingBranch, checkoutNewBranchAt } from '../../src/git/branch.js';
import { commitAll } from '../../src/git/repository.js';
import { mergeBranchInto } from '../../src/git/merge.js';
import { structuredOutputPath } from '../../src/orchestrator/structured-output.js';
import {
  initializeRunState,
  readRunMeta,
  readSlices,
  writeRunMeta,
  writeSlices,
} from '../../src/state/store.js';
import { runBranchFor } from '../../src/state/types.js';
import type { SdlcConfig } from '../../src/config/load-config.js';
import type { Slice } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

const baseConfig: SdlcConfig = {
  mergeMode: 'manual',
  reviewCycleCap: 3,
  conflictResolveCap: 3,
  inputSource: 'markdown-file',
  planner: { provider: 'claude' },
  implementer: { provider: 'claude' },
  reviewer: { provider: 'claude' },
};

async function setUpSingleSliceRun(repoDir: string, runId: string) {
  const paths = await initializeRunState(repoDir, runId, 'main');
  const slice: Slice = {
    id: 'only',
    title: 'Only slice',
    description: 'Do the only thing.',
    order: 0,
    status: 'pending',
    reviewCycles: 0,
    mergeAttempts: 0,
  };
  await writeSlices(paths, [slice]);
  const meta = await readRunMeta(paths);
  await writeRunMeta(paths, { ...meta, currentSliceId: 'only' });
  return paths;
}

describe('runReconcilerPass', () => {
  it('drives a pending slice to in_review on one pass', async () => {
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run1');
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(`${input.cwd}/impl.txt`, 'x');
      return { success: true, output: 'ok' };
    });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(false);
    const slices = await readSlices(paths);
    expect(slices[0].status).toBe('in_review');
  });

  it('uses implementProvider instead of provider for a pending slice when set', async () => {
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run1c');
    const provider = new FakeAgentProvider(async () => ({
      success: false,
      output: 'the wrong provider ran',
    }));
    const implementProvider = new FakeAgentProvider(async (input) => {
      await writeFile(`${input.cwd}/impl.txt`, 'x');
      return { success: true, output: 'ok' };
    });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      implementProvider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    const slices = await readSlices(paths);
    expect(slices[0].status).toBe('in_review');
  });

  it('does not advance within the same pass when the review step requests changes', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1b', 'main');
    const slices: Slice[] = [
      {
        id: 'other',
        title: 'Other slice',
        description: 'Some other slice ahead in the array.',
        order: 0,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'only',
        title: 'Only slice',
        description: 'Do the only thing.',
        order: 1,
        status: 'in_review',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ];
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'only' });
    await mkdir(paths.workspaceDir, { recursive: true });
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: false, feedback: 'Needs another pass.' }),
      );
      return { success: true, output: 'reviewed' };
    });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(false);
    const updatedSlices = await readSlices(paths);
    expect(updatedSlices.find((s) => s.id === 'only')?.status).toBe('pending');
    expect(updatedSlices.find((s) => s.id === 'only')?.reviewCycles).toBe(1);
  });

  it('folds the slice into the run branch and reports blocked on the final merge once every slice is done', async () => {
    // Distinct from finalize-run.test.ts's coverage of finalizeRun itself:
    // this pins the reconciler's handoff into it — the slice's own status
    // must already read 'merged' (folded into the run branch) while the
    // run-level merge is still pending, not 'ready_to_merge'.
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run2');
    let call = 0;
    const provider = new FakeAgentProvider(async (input) => {
      call += 1;
      if (call === 1) {
        await writeFile(`${input.cwd}/impl.txt`, 'x');
      } else {
        await writeFile(
          structuredOutputPath(input.cwd),
          JSON.stringify({ approved: true, feedback: '' }),
        );
      }
      return { success: true, output: 'ok' };
    });

    await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });
    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('not yet merged');
    const slices = await readSlices(paths);
    expect(slices[0].status).toBe('merged');
    const updatedMeta = await readRunMeta(paths);
    expect(updatedMeta.currentSliceId).toBeNull();
  });

  it('completes the run in one pass when auto mode merges the run branch right after the last slice is approved', async () => {
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run4');
    const slices = await readSlices(paths);
    slices[0].status = 'ready_to_merge';
    await writeSlices(paths, slices);
    // The run branch needs real commits for finalizeRun to have anything to
    // merge — this simulates the implement step having already run.
    await checkoutNewBranchAt(repo.dir, runBranchFor('run4'), 'main');
    await writeFile(`${repo.dir}/impl.txt`, 'x');
    await commitAll(repo.dir, 'implement only');
    await checkoutExistingBranch(repo.dir, 'main');

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: { ...baseConfig, mergeMode: 'auto' },
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(true);
    const updatedSlices = await readSlices(paths);
    expect(updatedSlices[0].status).toBe('merged');
  });

  it('reports complete once the run branch is already merged into base, with every slice already folded in', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4b', 'main');
    const slice: Slice = {
      id: 'only',
      title: 'Only slice',
      description: 'Do the only thing.',
      order: 0,
      status: 'merged',
      reviewCycles: 0,
      mergeAttempts: 0,
    };
    await writeSlices(paths, [slice]);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: null });
    await checkoutNewBranchAt(repo.dir, runBranchFor('run4b'), 'main');
    await writeFile(`${repo.dir}/impl.txt`, 'x');
    await commitAll(repo.dir, 'implement only');
    await checkoutExistingBranch(repo.dir, 'main');
    await mergeBranchInto(repo.dir, runBranchFor('run4b'), 'main');

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(true);
  });

  it('reports not complete when there is no current slice and no slices exist at all', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4c', 'main');
    await writeSlices(paths, []);

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(false);
  });

  it('reports not complete when the current slice id matches nothing but a slice is still unmerged', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4d', 'main');
    const slices: Slice[] = [
      {
        id: 'done',
        title: 'Done slice',
        description: 'Already folded into the run branch.',
        order: 0,
        status: 'merged',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'not-done',
        title: 'Not done slice',
        description: 'Still pending.',
        order: 1,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ];
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: null });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(false);
  });

  it('advances past an already-merged current slice to the next pending one instead of dead-ending', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run5', 'main');
    const slices: Slice[] = [
      {
        id: 'first',
        title: 'First slice',
        description: 'Already folded into the run branch.',
        order: 0,
        status: 'merged',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'second',
        title: 'Second slice',
        description: 'Still pending.',
        order: 1,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ];
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'first' });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    expect(result.complete).toBe(false);
    const updatedMeta = await readRunMeta(paths);
    expect(updatedMeta.currentSliceId).toBe('second');
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
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'high-order',
        title: 'High order',
        description: 'high',
        order: 2,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'low-order',
        title: 'Low order',
        description: 'low',
        order: 1,
        status: 'pending',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ];
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'current' });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    const updatedMeta = await readRunMeta(paths);
    expect(updatedMeta.currentSliceId).toBe('low-order');
  });
});
