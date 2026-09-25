import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { runReconcilerPass } from '../../src/orchestrator/reconcile.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { ManualMergeStrategy } from '../../src/strategies/merge/manual.js';
import { structuredOutputPath } from '../../src/orchestrator/structured-output.js';
import {
  initializeRunState,
  readRunMeta,
  readSlices,
  writeRunMeta,
  writeSlices,
} from '../../src/state/store.js';
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
  providerCommand: 'claude',
};

async function setUpSingleSliceRun(
  repoDir: string,
  runId: string,
): Promise<ReturnType<typeof initializeRunState>> {
  const paths = await initializeRunState(repoDir, runId, 'main');
  const slice: Slice = {
    id: 'only',
    title: 'Only slice',
    description: 'Do the only thing.',
    order: 0,
    status: 'pending',
    branch: `sdlc/slice/${runId}/only`,
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

  it('does not advance within the same pass when the review step requests changes', async () => {
    // Covers the negative side of the "did the review step just approve this
    // slice within this same pass?" check: a rejection must fall through to
    // the ordinary "blocked: false, complete: false" result, not race ahead
    // into runAdvance as if the slice had reached ready_to_merge.
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1b', 'main');
    const slices: Slice[] = [
      {
        id: 'other',
        title: 'Other slice',
        description: 'Some other slice ahead in the array.',
        order: 0,
        status: 'pending',
        branch: 'sdlc/slice/run1b/other',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'only',
        title: 'Only slice',
        description: 'Do the only thing.',
        order: 1,
        status: 'in_review',
        branch: 'sdlc/slice/run1b/only',
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

  it('reports blocked with a reason when manual mode reaches ready_to_merge', async () => {
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
    expect(result.reason).toMatch(/manual/i);
    const slices = await readSlices(paths);
    expect(slices[0].status).toBe('ready_to_merge');
  });

  it('advances directly when the pass starts with the slice already ready_to_merge', async () => {
    // Distinct from the "reaches ready_to_merge within this pass" case above:
    // here the slice is *already* ready_to_merge when the pass begins, so
    // the switch's own 'ready_to_merge' case (not the same-pass shortcut)
    // must thread the real repoRoot/paths/baseBranch/mergeStrategy through
    // to runAdvance and report the successful advance.
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run4');
    const slices = await readSlices(paths);
    slices[0].status = 'ready_to_merge';
    await writeSlices(paths, slices);

    const branch = await import('../../src/git/branch.js');
    const repository = await import('../../src/git/repository.js');
    await branch.checkoutNewBranchAt(repo.dir, slices[0].branch, 'main');
    await writeFile(`${repo.dir}/impl.txt`, 'x');
    await repository.commitAll(repo.dir, 'implement only');
    await branch.checkoutExistingBranch(repo.dir, 'main');

    const AutoMergeStrategy = (await import('../../src/strategies/merge/auto.js'))
      .AutoMergeStrategy;
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

  it('reports complete when the current slice id matches nothing and every slice is already merged', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4b', 'main');
    const slice: Slice = {
      id: 'only',
      title: 'Only slice',
      description: 'Do the only thing.',
      order: 0,
      status: 'merged',
      branch: 'sdlc/slice/run4b/only',
      reviewCycles: 0,
      mergeAttempts: 0,
    };
    await writeSlices(paths, [slice]);
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
    expect(result.complete).toBe(true);
  });

  it('reports not complete when there is no current slice and no slices exist at all', async () => {
    // `[].every(...)` is vacuously true in JS, so complete here hinges on
    // `slices.length > 0` actually short-circuiting the `&&` — an `||` in
    // its place, or a hardcoded `true`, would wrongly report complete.
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
        description: 'Already merged.',
        order: 0,
        status: 'merged',
        branch: 'sdlc/slice/run4d/done',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
      {
        id: 'not-done',
        title: 'Not done slice',
        description: 'Still pending.',
        order: 1,
        status: 'pending',
        branch: 'sdlc/slice/run4d/not-done',
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

  it('turns a real merge conflict into a blocked result instead of throwing', async () => {
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run3');
    const slices = await readSlices(paths);
    slices[0].status = 'ready_to_merge';
    await writeSlices(paths, slices);

    // Create the slice branch with a change that conflicts with a later commit on main.
    const branch = await import('../../src/git/branch.js');
    const repository = await import('../../src/git/repository.js');
    await branch.checkoutNewBranchAt(repo.dir, slices[0].branch, 'main');
    await writeFile(`${repo.dir}/README.md`, 'from slice\n');
    await repository.commitAll(repo.dir, 'change readme on slice');
    await branch.checkoutExistingBranch(repo.dir, 'main');
    await writeFile(`${repo.dir}/README.md`, 'from main\n');
    await repository.commitAll(repo.dir, 'change readme on main');

    const AutoMergeStrategy = (await import('../../src/strategies/merge/auto.js'))
      .AutoMergeStrategy;
    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.blocked).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('merge failed');
  });
});
