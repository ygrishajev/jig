import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalPrCreateStrategy } from '../../../src/strategies/pr/local.js';
import { getRunPaths } from '../../../src/state/run-paths.js';
import type { Slice } from '../../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('LocalPrCreateStrategy', () => {
  it('writes a PR description file into the state directory, not the workspace worktree', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run1');
    await mkdir(paths.stateDir, { recursive: true });
    const slice: Slice = {
      id: 's1',
      title: 'Add health route',
      description: 'Adds GET /health returning 200.',
      order: 0,
      status: 'ready_to_merge',
      branch: 'sdlc/slice/run1/s1',
      reviewCycles: 0,
      mergeAttempts: 0,
    };

    await new LocalPrCreateStrategy().create(paths, slice);

    const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
    expect(content).toContain('Add health route');
    expect(content).toContain('Adds GET /health returning 200.');
  });

  it('embeds the design and plan and marks the current slice in the mapping', async () => {
    repo = await createTempRepo();
    const { initializeRunState, writeSlices, readRunMeta, writeRunMeta } =
      await import('../../../src/state/store.js');
    const paths = await initializeRunState(repo.dir, 'run2', 'main');
    await writeFile(path.join(paths.stateDir, 'design.md'), '# Design\n\nA route returning 200.');
    await writeFile(path.join(paths.stateDir, 'plan.md'), '# Plan\n\n## Step 1 — Add health route');
    const s1: Slice = {
      id: 's1',
      title: 'Add health route',
      description: 'Implements plan step 1. Adds GET /health returning 200.',
      order: 0,
      status: 'ready_to_merge',
      branch: 'sdlc/slice/run2/s1',
      reviewCycles: 0,
      mergeAttempts: 0,
    };
    const s2: Slice = {
      ...s1,
      id: 's2',
      title: 'Second',
      description: 'Implements plan step 2. Wire the route into the app.',
      order: 1,
      status: 'pending',
      branch: 'sdlc/slice/run2/s2',
    };
    await writeSlices(paths, [s1, s2]);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 's1' });

    await new LocalPrCreateStrategy().create(paths, s1);

    const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
    expect(content).toContain('## Design');
    expect(content).toContain('A route returning 200.');
    expect(content).toContain('## Plan');
    expect(content).toContain('## Step 1 — Add health route');
    expect(content).toContain('**▶ s1 — Implements plan step 1. Adds GET /health returning 200.**');
    expect(content).toContain('- s2 — Implements plan step 2. Wire the route into the app.');
  });

  it('omits the design and plan sections when the run has no planning docs', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run3');
    await mkdir(paths.stateDir, { recursive: true });
    const slice: Slice = {
      id: 's1',
      title: 'Add health route',
      description: 'Adds GET /health returning 200.',
      order: 0,
      status: 'ready_to_merge',
      branch: 'sdlc/slice/run3/s1',
      reviewCycles: 0,
      mergeAttempts: 0,
    };

    await new LocalPrCreateStrategy().create(paths, slice);

    const content = await readFile(path.join(paths.stateDir, 'PR_DESCRIPTION.md'), 'utf-8');
    expect(content).not.toContain('## Design');
    expect(content).not.toContain('## Plan');
    expect(content).toContain('Add health route');
  });
});
