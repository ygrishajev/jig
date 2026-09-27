import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { runReviewStep } from '../../src/orchestrator/review-step.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { structuredOutputPath } from '../../src/orchestrator/structured-output.js';
import { commitAll } from '../../src/git/repository.js';
import { runImplementStep } from '../../src/orchestrator/implement-step.js';
import { getRunPaths } from '../../src/state/run-paths.js';
import { simpleGit } from 'simple-git';
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
  planner: { provider: 'claude' },
  implementer: { provider: 'claude' },
  reviewer: { provider: 'claude' },
};

describe('runReviewStep', () => {
  it('logs the review and its outcome, prefixed by the run id', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'runlog');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice({ branch: 'sdlc/slice/runlog/s1' });
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: true, feedback: '' }),
      );
      return { success: true, output: 'reviewed' };
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runReviewStep({ paths, slice, provider, config: baseConfig });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('[sdlc runlog]'))).toBe(true);
    expect(logged.some((line) => line.includes('reviewing slice "s1"'))).toBe(true);
    expect(logged.some((line) => line.includes('approved'))).toBe(true);
  });

  it('logs that changes were requested with the review cycle count', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'runlog2');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice({ branch: 'sdlc/slice/runlog2/s1' });
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: false, feedback: 'Missing a test.' }),
      );
      return { success: true, output: 'reviewed' };
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runReviewStep({ paths, slice, provider, config: baseConfig });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('changes requested (cycle 1/3)'))).toBe(true);
  });

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

  it('includes the verify command failure output in lastFeedback', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run4b');
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
      config: {
        ...baseConfig,
        verifyCommand: `sh -c "echo 'expected 2 got 3' >&2; exit 1"`,
      },
    });

    expect(slice.status).toBe('pending');
    expect(slice.lastFeedback).toContain('expected 2 got 3');
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

  it('requests changes instead of throwing when the provider succeeds but writes no structured output', async () => {
    // Regression for Important 4: a provider that exits 0 but forgets to
    // write the structured-output file used to let a raw ENOENT propagate
    // straight out of runReviewStep (and the whole reconciler pass), aborting
    // the entire autopilot run instead of being treated like any other
    // failed review attempt.
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run8');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async () => ({ success: true, output: 'reviewed' }));

    await expect(
      runReviewStep({ paths, slice, provider, config: baseConfig }),
    ).resolves.toBeUndefined();

    expect(slice.status).toBe('pending');
    expect(slice.reviewCycles).toBe(1);
    expect(slice.lastFeedback).toContain('did not produce valid structured output');
  });

  it('requests changes instead of throwing when the provider writes malformed JSON', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run9');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(structuredOutputPath(input.cwd), 'not valid json {');
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({ paths, slice, provider, config: baseConfig });

    expect(slice.status).toBe('pending');
    expect(slice.reviewCycles).toBe(1);
    expect(slice.lastFeedback).toContain('did not produce valid structured output');
  });

  it('requests changes when the reviewer provider itself fails to run', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run4c');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async () => ({ success: false, output: 'boom' }));

    await runReviewStep({ paths, slice, provider, config: baseConfig });

    expect(slice.status).toBe('pending');
    expect(slice.reviewCycles).toBe(1);
    expect(slice.lastFeedback).toContain('Review step failed to run');
    expect(slice.lastFeedback).toContain('boom');
  });

  it('marks the slice stuck exactly when reviewCycles reaches the cap, not before', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run4d');
    await mkdir(paths.workspaceDir, { recursive: true });
    // Starting one below the cap: this rejection brings reviewCycles to
    // exactly reviewCycleCap, the boundary where the slice must flip to
    // 'stuck'. A cap comparison that used `>` instead of `>=` would still
    // leave it 'pending' here.
    const slice = makeSlice({ reviewCycles: 2 });
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: false, feedback: 'Still not right.' }),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({ paths, slice, provider, config: { ...baseConfig, reviewCycleCap: 3 } });

    expect(slice.reviewCycles).toBe(3);
    expect(slice.status).toBe('stuck');
  });

  it('falls back to stdout when a failing verify command produced no stderr', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run4e');
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
      config: { ...baseConfig, verifyCommand: `sh -c "echo 'stdout only failure'; exit 1"` },
    });

    expect(slice.status).toBe('pending');
    expect(slice.lastFeedback).toContain('stdout only failure');
  });

  it('truncates a very long verify command failure to keep feedback bounded', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run4f');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: true, feedback: '' }),
      );
      return { success: true, output: 'reviewed' };
    });
    const longMessage = 'e'.repeat(450);

    await runReviewStep({
      paths,
      slice,
      provider,
      config: {
        ...baseConfig,
        verifyCommand: `sh -c "echo '${longMessage}' 1>&2; exit 1"`,
      },
    });

    expect(slice.status).toBe('pending');
    expect(slice.lastFeedback).toBeDefined();
    // 400-char truncation of the detail, plus the surrounding prose and the
    // trailing ellipsis — assert the detail itself was capped rather than
    // pinning the whole message to one exact length.
    const detailMatch = slice.lastFeedback?.match(/e+…/);
    expect(detailMatch).toBeTruthy();
    expect(detailMatch?.[0].length).toBe(401);
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

  it('does not leave a structured-output file behind for the next commitAll to sweep in', async () => {
    // Regression for Critical 2: resetStructuredOutput(paths.workspaceDir) was
    // only ever called BEFORE the provider ran, never again after reading the
    // result, so .sdlc-step-output.json sat untracked in the workspace
    // worktree until the next commitAll's `git add -A` landed the agent's raw
    // review-verdict JSON in the user's merged history.
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run7');
    const slice = makeSlice({ branch: 'sdlc/slice/run7/s1' });
    await runImplementStep({
      repoRoot: repo.dir,
      paths,
      slice,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async (input) => {
        await writeFile(`${input.cwd}/impl.txt`, 'x');
        return { success: true, output: 'ok' };
      }),
    });

    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: true, feedback: '' }),
      );
      return { success: true, output: 'reviewed' };
    });
    await runReviewStep({ paths, slice, provider, config: baseConfig });

    expect(existsSync(structuredOutputPath(paths.workspaceDir))).toBe(false);

    // Simulate the next thing that happens in this worktree: another commit
    // (e.g. a follow-up slice, or a manual fixup). Its tree must not contain
    // the structured-output filename.
    await writeFile(`${paths.workspaceDir}/more.txt`, 'y');
    const commitHash = await commitAll(paths.workspaceDir, 'follow-up commit');
    expect(commitHash).not.toBeNull();
    const committedFiles = await simpleGit({ baseDir: paths.workspaceDir }).raw([
      'ls-tree',
      '-r',
      '--name-only',
      'HEAD',
    ]);
    expect(committedFiles).not.toContain('.sdlc-step-output.json');
  });
});
