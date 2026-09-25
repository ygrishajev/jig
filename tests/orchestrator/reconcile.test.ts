import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
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
    const slices = await readSlices(paths);
    expect(slices[0].status).toBe('in_review');
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
    expect(result.reason).toMatch(/manual/i);
    const slices = await readSlices(paths);
    expect(slices[0].status).toBe('ready_to_merge');
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
    expect(result.reason).toContain('merge failed');
  });
});
