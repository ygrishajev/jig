import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeRunState,
  loadRunState,
  readRunMeta,
  readSlices,
  writeRunMeta,
  writeSlices,
} from '../../src/state/store.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

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
});
