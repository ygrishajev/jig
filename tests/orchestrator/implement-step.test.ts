import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ImplementStepFailedError,
  runImplementStep,
} from '../../src/orchestrator/implement-step.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { getRunPaths } from '../../src/state/run-paths.js';
import { isWorkingTreeClean } from '../../src/git/repository.js';
import { getCurrentBranch } from '../../src/git/branch.js';
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
    status: 'pending',
    branch: 'sdlc/slice/run1/s1',
    reviewCycles: 0,
    mergeAttempts: 0,
    ...overrides,
  };
}

describe('runImplementStep', () => {
  it('logs which slice it is implementing and the worktree path, prefixed by the run id', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'runlog');
    const slice = makeSlice({ branch: 'sdlc/slice/runlog/s1' });
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(path.join(input.cwd, 'health.ts'), 'export const health = () => "ok";\n');
      return { success: true, output: 'implemented' };
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes(`[sdlc runlog]`))).toBe(true);
    expect(logged.some((line) => line.includes('implementing slice "s1"'))).toBe(true);
    expect(logged.some((line) => line.includes(paths.workspaceDir))).toBe(true);
  });

  it('creates the workspace, runs the provider, commits, and advances status', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run1');
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(path.join(input.cwd, 'health.ts'), 'export const health = () => "ok";\n');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    expect(slice.status).toBe('in_review');
    expect(await getCurrentBranch(paths.workspaceDir)).toBe('sdlc/slice/run1/s1');
    expect(await isWorkingTreeClean(paths.workspaceDir)).toBe(true);
  });

  it('reuses the existing branch on a second call instead of recreating it', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run2');
    const slice = makeSlice({ branch: 'sdlc/slice/run2/s1' });
    let calls = 0;
    const provider = new FakeAgentProvider(async (input) => {
      calls += 1;
      await writeFile(path.join(input.cwd, `pass-${calls}.txt`), 'x');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });
    slice.status = 'pending';
    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    expect(calls).toBe(2);
    expect(await getCurrentBranch(paths.workspaceDir)).toBe('sdlc/slice/run2/s1');
  });

  it('throws and leaves status untouched when the provider fails', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run3');
    const slice = makeSlice({ branch: 'sdlc/slice/run3/s1' });
    const provider = new FakeAgentProvider(async () => ({ success: false, output: 'boom' }));

    await expect(
      runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider }),
    ).rejects.toThrow(ImplementStepFailedError);
    expect(slice.status).toBe('pending');
  });

  it('recreates the branch from base when the workspace worktree exists but the branch does not', async () => {
    // Exercises the fallback path distinct from the "reuse the existing
    // branch" test above: the worktree directory is already there, but the
    // slice's branch itself no longer exists (e.g. renamed away out of
    // band). ensureWorkspaceOnBranch must fall through to
    // checkoutNewBranchAt instead of trying to check out a branch that
    // isn't there.
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run5');
    const slice = makeSlice({ branch: 'sdlc/slice/run5/s1' });
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(path.join(input.cwd, 'first.txt'), 'x');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    const { openRepo } = await import('../../src/git/repository.js');
    await openRepo(paths.workspaceDir).raw([
      'branch',
      '-m',
      'sdlc/slice/run5/s1',
      'sdlc/slice/run5/renamed-away',
    ]);
    expect(await getCurrentBranch(paths.workspaceDir)).toBe('sdlc/slice/run5/renamed-away');

    slice.status = 'pending';
    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    expect(slice.status).toBe('in_review');
    expect(await getCurrentBranch(paths.workspaceDir)).toBe('sdlc/slice/run5/s1');
  });

  it('disables commit signing in the workspace only when skipCommitSigning is set', async () => {
    repo = await createTempRepo();
    const { openRepo } = await import('../../src/git/repository.js');
    await openRepo(repo.dir).raw(['config', 'commit.gpgsign', 'true']);
    const paths = getRunPaths(repo.dir, 'run6');
    const slice = makeSlice({ branch: 'sdlc/slice/run6/s1' });
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(path.join(input.cwd, 'health.ts'), 'export const health = () => "ok";\n');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({
      repoRoot: repo.dir,
      paths,
      slice,
      baseBranch: 'main',
      provider,
      skipCommitSigning: true,
    });

    expect((await openRepo(paths.workspaceDir).raw(['config', 'commit.gpgsign'])).trim()).toBe(
      'false',
    );
    expect((await openRepo(repo.dir).raw(['config', 'commit.gpgsign'])).trim()).toBe('true');
  });

  it('includes lastFeedback in the prompt when a previous review requested changes', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run4');
    const slice = makeSlice({
      branch: 'sdlc/slice/run4/s1',
      lastFeedback: 'The health check must also verify the database connection.',
    });
    let seenPrompt = '';
    const provider = new FakeAgentProvider(async (input) => {
      seenPrompt = input.prompt;
      await writeFile(path.join(input.cwd, 'health.ts'), 'export const health = () => "ok";\n');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    expect(seenPrompt).toContain('verify the database connection');
  });
});
