import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { aRunState } from '../../tests/support/builders.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createRemote } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { GitRemoteRunStore } from '../adapters/run-store/git-remote-run-store.js';
import { configFileFor, loadConfig } from '../config/load-config.js';
import { ConfigInvalid } from '../domain/errors.js';
import { openRunStore } from './run-stores.js';

describe('openRunStore', () => {
  it('adds required stores once while keeping configured stores', async () => {
    const { repoRoot, config, state } = await setup();
    const store = unwrap(
      await openRunStore({ repoRoot, config }, ['git-remote', 'local', 'git-remote']),
    );
    unwrap(await store.save(state));
    const local = unwrap(await new LocalRunStore(repoRoot).load(state.runId));
    const remote = unwrap(await new GitRemoteRunStore(repoRoot).load(state.runId));
    expect(local).toEqual(remote);
    expect(local?.revision).toBe(state.revision + 1);
  });

  it('saves to the local store by default', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    const store = (
      await openRunStore({ repoRoot, config: unwrap(loadConfig(configFileFor(repoRoot))) })
    ).unwrap();
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
      await openRunStore({
        repoRoot,
        config: { ...unwrap(loadConfig(configFileFor(repoRoot))), runStores },
      })
    ).unwrap();
    const state = aRunState();

    await store.save(state);

    const saved = { ...state, revision: state.revision + 1 };
    expect((await new LocalRunStore(repoRoot).load(state.runId)).unwrap()).toEqual(saved);
    const reopened = (
      await openRunStore({
        repoRoot,
        config: { ...unwrap(loadConfig(configFileFor(repoRoot))), runStores },
      })
    ).unwrap();
    expect((await reopened.load(state.runId)).unwrap()).toEqual(saved);
  });

  it('peeks through a module store that has no peek of its own by loading from it', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    const state = aRunState();
    await writeFile(
      path.join(repoRoot, 'load-only-store.mjs'),
      `export default () => ({
         load: async () => (${JSON.stringify(state)}),
         save: async () => {},
       });`,
    );
    const config = {
      ...unwrap(loadConfig(configFileFor(repoRoot))),
      runStores: ['load-only-store.mjs'],
    };

    const store = (await openRunStore({ repoRoot, config })).unwrap();

    expect((await store.peek(state.runId)).unwrap()).toEqual(state);
  });

  it("gives a module store the repository's root and saves through it", async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    await writeFile(
      path.join(repoRoot, 'file-store.mjs'),
      `import { writeFileSync } from 'node:fs';
       import path from 'node:path';
       export default ({ repoRoot }) => ({
         load: async () => undefined,
         save: async (state) => writeFileSync(path.join(repoRoot, 'saved.json'), JSON.stringify(state)),
       });`,
    );
    const config = {
      ...unwrap(loadConfig(configFileFor(repoRoot))),
      runStores: ['file-store.mjs'],
    };
    const state = aRunState();

    await (await openRunStore({ repoRoot, config })).unwrap().save(state);

    expect(JSON.parse(await readFile(path.join(repoRoot, 'saved.json'), 'utf-8'))).toMatchObject({
      runId: state.runId,
    });
  });

  it.each(['undefined', 'null'])(
    'reads a run a module store answers %s for as not there',
    async (answer) => {
      const repoRoot = await tempDirectory('jig-stores-');
      await writeFile(
        path.join(repoRoot, 'empty-store.mjs'),
        `export default () => ({ load: async () => ${answer}, save: async () => {} });`,
      );
      const config = {
        ...unwrap(loadConfig(configFileFor(repoRoot))),
        runStores: ['empty-store.mjs'],
      };

      const store = (await openRunStore({ repoRoot, config })).unwrap();

      expect((await store.load(aRunState().runId)).unwrap()).toBeUndefined();
    },
  );

  it('refuses a run a module store hands back that is not a run', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    await writeFile(
      path.join(repoRoot, 'broken-store.mjs'),
      `export default () => ({ load: async () => ({ phase: 'nowhere' }), save: async () => {} });`,
    );
    const config = {
      ...unwrap(loadConfig(configFileFor(repoRoot))),
      runStores: ['broken-store.mjs'],
    };
    const store = (await openRunStore({ repoRoot, config })).unwrap();

    const loaded = await store.load(aRunState().runId);

    expect(loaded.isErr() && loaded.error).toBeInstanceOf(ConfigInvalid);
  });

  it("reports a store module that throws as the operator's config", async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    await writeFile(
      path.join(repoRoot, 'throwing-store.mjs'),
      `export default () => ({
         load: async () => { throw new Error('disk on fire'); },
         save: async () => {},
       });`,
    );
    const config = {
      ...unwrap(loadConfig(configFileFor(repoRoot))),
      runStores: ['throwing-store.mjs'],
    };
    const store = (await openRunStore({ repoRoot, config })).unwrap();

    const loaded = await store.load(aRunState().runId);

    expect(loaded.isErr() && loaded.error).toBeInstanceOf(ConfigInvalid);
    expect(loaded.isErr() && loaded.error.message).toContain('throwing-store.mjs');
  });

  it('refuses a module whose factory does not return a store with load and save', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    await writeFile(
      path.join(repoRoot, 'half-a-store.mjs'),
      'export default () => ({ load: async () => undefined });',
    );
    const config = {
      ...unwrap(loadConfig(configFileFor(repoRoot))),
      runStores: ['half-a-store.mjs'],
    };

    const opened = await openRunStore({ repoRoot, config });

    expect(opened.isErr() && opened.error).toBeInstanceOf(ConfigInvalid);
  });

  it('refuses a module that does not export a store factory', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    await writeFile(path.join(repoRoot, 'not-a-store.mjs'), 'export const store = {};');
    const config = {
      ...unwrap(loadConfig(configFileFor(repoRoot))),
      runStores: ['not-a-store.mjs'],
    };

    const opened = await openRunStore({ repoRoot, config });

    expect(opened.isErr() && opened.error).toBeInstanceOf(ConfigInvalid);
  });

  async function setup() {
    const { cloneOf } = await createRemote();
    const repoRoot = await cloneOf();
    return { repoRoot, config: unwrap(loadConfig(configFileFor(repoRoot))), state: aRunState() };
  }
});
