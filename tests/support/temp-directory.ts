import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';

/** A fresh empty directory, removed once the test that asked for it finishes. */
export async function tempDirectory(prefix = 'sdlc-test-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
