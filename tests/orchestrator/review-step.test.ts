import { afterEach, describe, expect, it } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { runReviewStep } from '../../src/orchestrator/review-step.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { structuredOutputPath } from '../../src/orchestrator/structured-output.js';
import { getRunPaths } from '../../src/state/run-paths.js';
import type { SdlcConfig } from '../../src/config/load-config.js';
import type { Slice } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

function makeSlice(overrides: Partial<Slice> = {}): Slice {
  return {
    id: 's1',
    title: 'First slice',
    description: 'Do the first thing.',
    order: 0,
    status: 'in_review',
    branch: 'sdlc/slice/run1/s1',
    reviewCycles: 0,
    mergeAttempts: 0,
    ...overrides,
  };
}

const baseConfig: SdlcConfig = {
  mergeMode: 'manual',
  reviewCycleCap: 3,
  conflictResolveCap: 3,
  inputSource: 'markdown-file',
  providerCommand: 'claude',
};

describe('runReviewStep', () => {
  it('moves to ready_to_merge when the reviewer approves and no verify command is set', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run1');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: true, feedback: '' }),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({ paths, slice, provider, config: baseConfig });

    expect(slice.status).toBe('ready_to_merge');
  });

  it('loops back to pending with an incremented cycle count when changes are requested', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run2');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: false, feedback: 'Missing a test.' }),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({ paths, slice, provider, config: baseConfig });

    expect(slice.status).toBe('pending');
    expect(slice.reviewCycles).toBe(1);
  });

  it('marks the slice stuck once the review cycle cap is exceeded', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run3');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice({ reviewCycles: 3 });
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: false, feedback: 'Still wrong.' }),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({ paths, slice, provider, config: { ...baseConfig, reviewCycleCap: 3 } });

    expect(slice.status).toBe('stuck');
  });

  it('treats a failing verify command as changes requested even if the reviewer approved', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run4');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: true, feedback: '' }),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({
      paths,
      slice,
      provider,
      config: { ...baseConfig, verifyCommand: 'exit 1' },
    });

    expect(slice.status).toBe('pending');
    expect(slice.reviewCycles).toBe(1);
  });

  it('reaches ready_to_merge when both the reviewer and the verify command pass', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run5');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: true, feedback: '' }),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({
      paths,
      slice,
      provider,
      config: { ...baseConfig, verifyCommand: 'exit 0' },
    });

    expect(slice.status).toBe('ready_to_merge');
  });

  it('records the reviewer feedback on the slice and clears it once approved', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run6');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    let approve = false;
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify(
          approve
            ? { approved: true, feedback: '' }
            : { approved: false, feedback: 'Add error handling for a missing database.' },
        ),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({ paths, slice, provider, config: baseConfig });
    expect(slice.lastFeedback).toBe('Add error handling for a missing database.');

    approve = true;
    await runReviewStep({ paths, slice, provider, config: baseConfig });
    expect(slice.lastFeedback).toBeUndefined();
  });
});
