import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finalizeRun } from '../../src/orchestrator/finalize-run.js';
import { AutoMergeStrategy } from '../../src/strategies/merge/auto.js';
import { ManualMergeStrategy } from '../../src/strategies/merge/manual.js';
import { checkoutExistingBranch, checkoutNewBranchAt } from '../../src/git/branch.js';
import { commitAll, isWorkingTreeClean } from '../../src/git/repository.js';
import { mergeBranchInto } from '../../src/git/merge.js';
import { initializeRunState } from '../../src/state/store.js';
import { runBranchFor } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

async function commitOnRunBranch(repoDir: string, runId: string, filename: string): Promise<void> {
  await checkoutNewBranchAt(repoDir, runBranchFor(runId), 'main');
  await writeFile(path.join(repoDir, filename), 'x');
  await commitAll(repoDir, `implement ${filename}`);
  await checkoutExistingBranch(repoDir, 'main');
}

describe('finalizeRun', () => {
  it('logs which run branch was merged into which base branch', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'runlog', 'main');
    await commitOnRunBranch(repo.dir, 'runlog', 'first.txt');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    const logged = logSpy.mock.calls.map((args) => args.join(' '));
    expect(logged.some((line) => line.includes('[sdlc runlog]'))).toBe(true);
    expect(
      logged.some((line) => line.includes('run branch "sdlc/run/runlog" merged into "main"')),
    ).toBe(true);
  });

  it('auto-merges the run branch and reports the run complete', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    await commitOnRunBranch(repo.dir, 'run1', 'first.txt');

    const result = await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result).toEqual({ blocked: false, complete: true });
  });

  it('detects a manual merge already performed and reports complete without merging itself', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run2', 'main');
    await commitOnRunBranch(repo.dir, 'run2', 'first.txt');
    await mergeBranchInto(repo.dir, runBranchFor('run2'), 'main');

    const result = await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result).toEqual({ blocked: false, complete: true });
  });

  it('reports blocked when manual mode has not merged the run branch yet', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3', 'main');
    await commitOnRunBranch(repo.dir, 'run3', 'first.txt');

    const result = await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('not yet merged');
  });

  it('turns a real merge conflict into a blocked result instead of throwing', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4', 'main');
    await checkoutNewBranchAt(repo.dir, runBranchFor('run4'), 'main');
    await writeFile(path.join(repo.dir, 'README.md'), 'from run branch\n');
    await commitAll(repo.dir, 'change readme on run branch');
    await checkoutExistingBranch(repo.dir, 'main');
    await writeFile(path.join(repo.dir, 'README.md'), 'from main\n');
    await commitAll(repo.dir, 'change readme on main');

    const result = await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.blocked).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('merge failed');
    expect(await isWorkingTreeClean(repo.dir)).toBe(true);
  });

  it('reports blocked, not complete, when the run branch does not exist yet', async () => {
    // A run whose first slice hasn't implemented anything yet has no run
    // branch at all — isBranchMergedInto's catch path treats a nonexistent
    // branch as "not merged", so this pins that case as blocked rather than
    // a false "complete".
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run5', 'main');

    const result = await finalizeRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(true);
    expect(result.complete).toBe(false);
  });
});
