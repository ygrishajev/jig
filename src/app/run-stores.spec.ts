import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { aRunState } from '../../tests/support/builders.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { loadConfig } from '../config/load-config.js';
import { ConfigInvalid } from '../domain/errors.js';
import { openRunStore } from './run-stores.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';

describe('openRunStore', () => {
  it('saves to the local store by default', async () => {
    const repoRoot = await tempDirectory('sdlc-stores-');
    const store = await openRunStore({ repoRoot, config: loadConfig(repoRoot) });
    const state = aRunState();

    await store.save(state);

    expect(await new LocalRunStore(repoRoot).load(state.runId)).toEqual({
      ...state,
      revision: state.revision + 1,
    });
  });

  it('saves to every configured store, including one loaded from a module', async () => {
    const repoRoot = await tempDirectory('sdlc-stores-');
    await writeFile(
      path.join(repoRoot, 'memory-store.mjs'),
      `const saved = new Map();
       export default () => ({
         load: async (runId) => saved.get(runId),
         save: async (state) => { saved.set(state.runId, state); },
       });`,
    );
    const runStores = ['memory-store.mjs', 'local'];
    const store = await openRunStore({ repoRoot, config: { ...loadConfig(repoRoot), runStores } });
    const state = aRunState();

    await store.save(state);

    const saved = { ...state, revision: state.revision + 1 };
    expect(await new LocalRunStore(repoRoot).load(state.runId)).toEqual(saved);
    const reopened = await openRunStore({
      repoRoot,
      config: { ...loadConfig(repoRoot), runStores },
    });
    expect(await reopened.load(state.runId)).toEqual(saved);
  });

  it('peeks through a module store that has no peek of its own by loading from it', async () => {
    const repoRoot = await tempDirectory('sdlc-stores-');
    const state = aRunState();
    await writeFile(
      path.join(repoRoot, 'load-only-store.mjs'),
      `export default () => ({
         load: async () => (${JSON.stringify(state)}),
         save: async () => {},
       });`,
    );
    const config = { ...loadConfig(repoRoot), runStores: ['load-only-store.mjs'] };

    const store = await openRunStore({ repoRoot, config });

    expect(await store.peek(state.runId)).toEqual(state);
  });

  it("gives a module store the repository's root and saves through it", async () => {
    const repoRoot = await tempDirectory('sdlc-stores-');
    await writeFile(
      path.join(repoRoot, 'file-store.mjs'),
      `import { writeFileSync } from 'node:fs';
       import path from 'node:path';
       export default ({ repoRoot }) => ({
         load: async () => undefined,
         save: async (state) => writeFileSync(path.join(repoRoot, 'saved.json'), JSON.stringify(state)),
       });`,
    );
    const config = { ...loadConfig(repoRoot), runStores: ['file-store.mjs'] };
    const state = aRunState();

    await (await openRunStore({ repoRoot, config })).save(state);

    expect(JSON.parse(await readFile(path.join(repoRoot, 'saved.json'), 'utf-8'))).toMatchObject({
      runId: state.runId,
    });
  });

  it.each(['undefined', 'null'])(
    'reads a run a module store answers %s for as not there',
    async (answer) => {
      const repoRoot = await tempDirectory('sdlc-stores-');
      await writeFile(
        path.join(repoRoot, 'empty-store.mjs'),
        `export default () => ({ load: async () => ${answer}, save: async () => {} });`,
      );
      const config = { ...loadConfig(repoRoot), runStores: ['empty-store.mjs'] };

      const store = await openRunStore({ repoRoot, config });

      expect(await store.load(aRunState().runId)).toBeUndefined();
    },
  );

  it('refuses a run a module store hands back that is not a run', async () => {
    const repoRoot = await tempDirectory('sdlc-stores-');
    await writeFile(
      path.join(repoRoot, 'broken-store.mjs'),
      `export default () => ({ load: async () => ({ phase: 'nowhere' }), save: async () => {} });`,
    );
    const config = { ...loadConfig(repoRoot), runStores: ['broken-store.mjs'] };
    const store = await openRunStore({ repoRoot, config });

    await expect(store.load(aRunState().runId)).rejects.toBeInstanceOf(ConfigInvalid);
  });

  it('refuses a module whose factory does not return a store with load and save', async () => {
    const repoRoot = await tempDirectory('sdlc-stores-');
    await writeFile(
      path.join(repoRoot, 'half-a-store.mjs'),
      'export default () => ({ load: async () => undefined });',
    );
    const config = { ...loadConfig(repoRoot), runStores: ['half-a-store.mjs'] };

    await expect(openRunStore({ repoRoot, config })).rejects.toBeInstanceOf(ConfigInvalid);
  });

  it('refuses a module that does not export a store factory', async () => {
    const repoRoot = await tempDirectory('sdlc-stores-');
    await writeFile(path.join(repoRoot, 'not-a-store.mjs'), 'export const store = {};');
    const config = { ...loadConfig(repoRoot), runStores: ['not-a-store.mjs'] };

    await expect(openRunStore({ repoRoot, config })).rejects.toBeInstanceOf(ConfigInvalid);
  });
});
