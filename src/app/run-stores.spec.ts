import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { aJigConfig, aRunState } from '../../tests/support/builders.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { RepositoryRunStores } from '../adapters/run-store/repository-run-stores.js';
import { openRunStore } from './run-stores.js';

describe('openRunStore', () => {
  it('saves to the local store by default', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    const store = (await openRunStore(new RepositoryRunStores(repoRoot), aJigConfig())).unwrap();
    const state = aRunState();

    await store.save(state);

    expect((await new LocalRunStore(repoRoot).load(state.runId)).unwrap()).toEqual({
      ...state,
      revision: state.revision + 1,
    });
  });

  it('saves to every configured store, including one loaded from a module', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    await writeFile(
      path.join(repoRoot, 'memory-store.mjs'),
      `const saved = new Map();
       export default () => ({
         load: async (runId) => saved.get(runId),
         save: async (state) => { saved.set(state.runId, state); },
       });`,
    );
    const runStores = ['memory-store.mjs', 'local'];
    const store = (
      await openRunStore(new RepositoryRunStores(repoRoot), aJigConfig({ runStores }))
    ).unwrap();
    const state = aRunState();

    await store.save(state);

    const saved = { ...state, revision: state.revision + 1 };
    expect((await new LocalRunStore(repoRoot).load(state.runId)).unwrap()).toEqual(saved);
    const reopened = (
      await openRunStore(new RepositoryRunStores(repoRoot), aJigConfig({ runStores }))
    ).unwrap();
    expect((await reopened.load(state.runId)).unwrap()).toEqual(saved);
  });
});
