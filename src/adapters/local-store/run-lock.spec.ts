import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { RunInProgress } from '../../domain/errors.js';
import { lockRun } from './run-lock.js';

describe('lockRun', () => {
  it('refuses a second writer for a run while the first holds it', async () => {
    const { repoRoot, id } = await setup();
    const release = await lockRun(repoRoot, id);

    await expect(lockRun(repoRoot, id)).rejects.toBeInstanceOf(RunInProgress);
    await release();
  });

  it('lets the next writer in once the first releases the run', async () => {
    const { repoRoot, id } = await setup();
    await (
      await lockRun(repoRoot, id)
    )();

    const release = await lockRun(repoRoot, id);

    await release();
  });

  it('locks each run on its own', async () => {
    const { repoRoot, id } = await setup();
    const release = await lockRun(repoRoot, id);

    const other = await lockRun(repoRoot, runId());

    await other();
    await release();
  });

  async function setup() {
    return { repoRoot: await tempDirectory('sdlc-lock-'), id: runId() };
  }
});
