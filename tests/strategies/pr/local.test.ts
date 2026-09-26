import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
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
});
