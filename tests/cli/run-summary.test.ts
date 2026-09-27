import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { printRunSummary } from '../../src/cli/run-summary.js';
import { checkoutExistingBranch, checkoutNewBranchAt } from '../../src/git/branch.js';
import { commitAll } from '../../src/git/repository.js';
import { initializeRunState } from '../../src/state/store.js';
import { runBranchFor } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
  vi.restoreAllMocks();
});

describe('printRunSummary', () => {
  it('prints the worktree path and the commits the run branch has over the base branch', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    await checkoutNewBranchAt(repo.dir, runBranchFor('run1'), 'main');
    await writeFile(path.join(repo.dir, 'feature.txt'), 'x');
    await commitAll(repo.dir, 'implement the feature');
    await checkoutExistingBranch(repo.dir, 'main');
    await writeFile(path.join(paths.stateDir, 'design.md'), '# Design');
    await writeFile(path.join(paths.stateDir, 'plan.md'), '# Plan');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await printRunSummary({ repoRoot: repo.dir, paths, baseBranch: 'main' });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes(`Worktree: ${paths.workspaceDir}`))).toBe(true);
    expect(
      logged.some((line) => line.startsWith('Design: ') && line.endsWith('state/design.md')),
    ).toBe(true);
    expect(logged.some((line) => line.startsWith('Plan: ') && line.endsWith('state/plan.md'))).toBe(
      true,
    );
    expect(logged.some((line) => line.includes('Commits on run branch'))).toBe(true);
    expect(logged.some((line) => line.includes('implement the feature'))).toBe(true);
  });

  it('prints (none) when the run branch has no commits over the base branch', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run2', 'main');
    await checkoutNewBranchAt(repo.dir, runBranchFor('run2'), 'main');
    await checkoutExistingBranch(repo.dir, 'main');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await printRunSummary({ repoRoot: repo.dir, paths, baseBranch: 'main' });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('Worktree:'))).toBe(true);
    expect(logged.some((line) => line.trim() === '(none)')).toBe(true);
  });

  it('prints (none) when the run branch does not exist yet', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3', 'main');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await printRunSummary({ repoRoot: repo.dir, paths, baseBranch: 'main' });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('Worktree:'))).toBe(true);
    expect(logged.some((line) => line.trim() === '(none)')).toBe(true);
  });
});
