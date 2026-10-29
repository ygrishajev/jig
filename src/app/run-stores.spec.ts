import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aRunState } from '../../tests/support/builders.js';
import { InMemoryRunStore } from '../../tests/support/fakes.js';
import { GitRemoteRunStore } from '../adapters/run-store/git-remote-run-store.js';
import { createRunStore } from './run-stores.js';

describe('createRunStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('uses the local store on its own by default', async () => {
    const local = new InMemoryRunStore();

    expect(await createRunStore({ repoRoot: await directory(), names: ['local'], local })).toBe(
      local,
    );
  });

  it('saves to every configured store and loads from the first that has the run', async () => {
    const repoRoot = await directory();
    const local = new InMemoryRunStore();
    await writeFile(
      path.join(repoRoot, 'memory-store.mjs'),
      `const saved = new Map();
       export default () => ({
         load: async (runId) => saved.get(runId),
         save: async (state) => { saved.set(state.runId, state); },
       });`,
    );
    const store = await createRunStore({ repoRoot, names: ['memory-store.mjs', 'local'], local });
    const state = aRunState();

    await store.save(state);

    expect(await local.load(state.runId)).toEqual(state);
    expect(await store.load(state.runId)).toEqual(state);
  });

  it('builds the git remote store by name', async () => {
    const store = await createRunStore({
      repoRoot: await directory(),
      names: ['git-remote'],
      local: new InMemoryRunStore(),
    });

    expect(store).toBeInstanceOf(GitRemoteRunStore);
  });

  it('refuses a module that does not export a store factory', async () => {
    const repoRoot = await directory();
    await writeFile(path.join(repoRoot, 'not-a-store.mjs'), 'export const store = {};');

    await expect(
      createRunStore({ repoRoot, names: ['not-a-store.mjs'], local: new InMemoryRunStore() }),
    ).rejects.toThrow('must default-export a function');
  });

  async function directory() {
    const created = await mkdtemp(path.join(tmpdir(), 'sdlc-stores-'));
    directories.push(created);
    return created;
  }
});
