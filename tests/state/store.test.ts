import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import {
  initializeRunState,
  loadRunState,
  readRunMeta,
  readSlices,
  writeRunMeta,
  writeSlices,
} from '../../src/state/store.js';
import {
  createTempRepo,
  createTempRepoWithoutSdlcIgnore,
  type TempRepo,
} from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('state store', () => {
  it('initializes run state with a seeded run meta', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    const meta = await readRunMeta(paths);
    expect(meta.runId).toBe('run1');
    expect(meta.baseBranch).toBe('main');
    expect(await readSlices(paths)).toEqual([]);
  });

  it('round-trips slices through write and read', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run2', 'main');
    await writeSlices(paths, [
      {
        id: 's1',
        title: 'First slice',
        description: 'Does the first thing.',
        order: 0,
        status: 'pending',
        branch: 'sdlc/slice/run2/s1',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ]);
    const slices = await readSlices(paths);
    expect(slices).toHaveLength(1);
    expect(slices[0].id).toBe('s1');
  });

  it('reloads an existing run via loadRunState', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3', 'main');
    await writeRunMeta(paths, {
      runId: 'run3',
      baseBranch: 'main',
      currentSliceId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const reloaded = await loadRunState(repo.dir, 'run3');
    const meta = await readRunMeta(reloaded);
    expect(meta.runId).toBe('run3');
  });

  it('throws a clear error when the run does not exist', async () => {
    repo = await createTempRepo();
    await expect(loadRunState(repo.dir, 'no-such-run')).rejects.toThrow(/no-such-run/);
  });

  it('self-ignores .sdlc/ in a target repo whose own .gitignore never mentions it', async () => {
    // Reproduces Critical 1: in a real target repo (unlike this project's own
    // test fixtures, which pre-ignore .sdlc/ as an unrelated Task 14 fix),
    // .sdlc/ starts out fully untracked. Without a self-ignoring
    // .sdlc/.gitignore, every file initializeRunState writes shows up as
    // untracked/dirty, which is exactly what makes `isWorkingTreeClean` (and
    // therefore every merge) fail 100% of the time in such a repo.
    repo = await createTempRepoWithoutSdlcIgnore();

    await initializeRunState(repo.dir, 'run1', 'main');

    const status = await simpleGit({ baseDir: repo.dir }).status(['--porcelain']);
    expect(status.isClean()).toBe(true);
    expect(existsSync(path.join(repo.dir, '.sdlc', '.gitignore'))).toBe(true);
    expect(await readFile(path.join(repo.dir, '.sdlc', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  it('does not touch an existing .sdlc/.gitignore on a second run in the same repo', async () => {
    repo = await createTempRepoWithoutSdlcIgnore();
    await initializeRunState(repo.dir, 'run1', 'main');
    const sdlcGitignorePath = path.join(repo.dir, '.sdlc', '.gitignore');
    await writeFile(sdlcGitignorePath, '*\n# customized\n', 'utf-8');

    await initializeRunState(repo.dir, 'run2', 'main');

    expect(await readFile(sdlcGitignorePath, 'utf-8')).toBe('*\n# customized\n');
  });
});
