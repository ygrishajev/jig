import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { RunInProgress } from '../../domain/errors.js';
import { lockRun } from './run-lock.js';

describe('lockRun', () => {
  it('refuses a second process on the same run', async () => {
    const { repoRoot, id } = await setup();
    const release = (await lockRun(repoRoot, id)).unwrap();

    const second = await lockRun(repoRoot, id);

    expect(second.isErr() && second.error).toBeInstanceOf(RunInProgress);
    await release();
  });

  it('lets the next writer in once the first releases the run', async () => {
    const { repoRoot, id } = await setup();
    await (await lockRun(repoRoot, id)).unwrap()();

    const release = (await lockRun(repoRoot, id)).unwrap();

    await release();
  });

  it('locks each run on its own', async () => {
    const { repoRoot, id } = await setup();
    const release = (await lockRun(repoRoot, id)).unwrap();

    const other = (await lockRun(repoRoot, runId())).unwrap();

    await other();
    await release();
  });

  async function setup() {
    return { repoRoot: await tempDirectory('jig-lock-'), id: runId() };
  }
});
