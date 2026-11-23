import { faker } from '@faker-js/faker';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { aRunState } from '../../tests/support/builders.js';
import { repositoryConfig } from '../../tests/support/repository-config.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createRemote } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { GitRemoteRunStore } from '../adapters/run-store/git-remote-run-store.js';
import { runBranchFor } from '../domain/run-state.js';
import { RunStateInvalid, RunStoreFailed } from '../ports/run-state-failures.js';
import { RunStoreSetupInvalid } from './run-store-setup-invalid.js';
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
    const store = (await openRunStore({ repoRoot, config: repositoryConfig(repoRoot) })).unwrap();
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
        config: { ...repositoryConfig(repoRoot), runStores },
      })
    ).unwrap();
    const state = aRunState();

    await store.save(state);

    const saved = { ...state, revision: state.revision + 1 };
    expect((await new LocalRunStore(repoRoot).load(state.runId)).unwrap()).toEqual(saved);
    const reopened = (
      await openRunStore({
        repoRoot,
        config: { ...repositoryConfig(repoRoot), runStores },
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
      ...repositoryConfig(repoRoot),
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
      ...repositoryConfig(repoRoot),
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
        ...repositoryConfig(repoRoot),
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
      ...repositoryConfig(repoRoot),
      runStores: ['broken-store.mjs'],
    };
    const store = (await openRunStore({ repoRoot, config })).unwrap();

    const loaded = await store.load(aRunState().runId);

    expect(loaded.isErr() && loaded.error).toBeInstanceOf(RunStateInvalid);
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
      ...repositoryConfig(repoRoot),
      runStores: ['throwing-store.mjs'],
    };
    const store = (await openRunStore({ repoRoot, config })).unwrap();

    const loaded = await store.load(aRunState().runId);

    expect(loaded.isErr() && loaded.error).toBeInstanceOf(RunStoreFailed);
    expect(loaded.isErr() && loaded.error.message).toContain('throwing-store.mjs');
  });

  it('refuses a module whose factory does not return a store with load and save', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    await writeFile(
      path.join(repoRoot, 'half-a-store.mjs'),
      'export default () => ({ load: async () => undefined });',
    );
    const config = {
      ...repositoryConfig(repoRoot),
      runStores: ['half-a-store.mjs'],
    };

    const opened = await openRunStore({ repoRoot, config });

    expect(opened.isErr() && opened.error).toBeInstanceOf(RunStoreSetupInvalid);
  });

  it('refuses a module that does not export a store factory', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    await writeFile(path.join(repoRoot, 'not-a-store.mjs'), 'export const store = {};');
    const config = {
      ...repositoryConfig(repoRoot),
      runStores: ['not-a-store.mjs'],
    };

    const opened = await openRunStore({ repoRoot, config });

    expect(opened.isErr() && opened.error).toBeInstanceOf(RunStoreSetupInvalid);
  });

  it('resumes an interrupted deferred run from the code checkpoint this clone kept', async () => {
    const { repoRoot, config, deferred } = await setup();
    const branch = runBranchFor(deferred.runId);
    const checkpoint = await commitOn(repoRoot, branch);
    unwrap(await unwrap(await openRunStore({ repoRoot, config }, ['git-remote'])).save(deferred));
    await simpleGit(repoRoot).branch(['-D', branch]);

    const resumed = unwrap(
      await unwrap(await openRunStore({ repoRoot, config }, ['git-remote'])).load(deferred.runId),
    );

    expect(resumed?.codeRevision).toBe(checkpoint);
    expect(await simpleGit(repoRoot).revparse([branch])).toBe(checkpoint);
    expect(await simpleGit(repoRoot).listRemote(['origin', `refs/heads/${branch}`])).toBe('');
  });

  it('refuses to resume a deferred run on a clone without its unpublished code', async () => {
    const { repoRoot, config, deferred, cloneOf } = await setup();
    await commitOn(repoRoot, runBranchFor(deferred.runId));
    unwrap(await unwrap(await openRunStore({ repoRoot, config }, ['git-remote'])).save(deferred));
    const elsewhere = await cloneOf();

    const loaded = await unwrap(
      await openRunStore({ repoRoot: elsewhere, config }, ['git-remote']),
    ).load(deferred.runId);

    expect(loaded.isErr() && loaded.error._tag).toBe('RunCodeUnavailable');
  });

  it('resumes a deferred run on another clone once its checkpoint was published', async () => {
    const { repoRoot, config, deferred, cloneOf } = await setup();
    const branch = runBranchFor(deferred.runId);
    const checkpoint = await commitOn(repoRoot, branch);
    unwrap(await unwrap(await openRunStore({ repoRoot, config }, ['git-remote'])).save(deferred));
    await simpleGit(repoRoot).push(['origin', `${checkpoint}:refs/heads/${branch}`]);
    const elsewhere = await cloneOf();

    const resumed = unwrap(
      await unwrap(await openRunStore({ repoRoot: elsewhere, config }, ['git-remote'])).load(
        deferred.runId,
      ),
    );

    expect(resumed?.codeRevision).toBe(checkpoint);
    expect(await simpleGit(elsewhere).revparse([branch])).toBe(checkpoint);
  });

  it.each(['load', 'peek', 'save'] as const)(
    'reports a custom store %s failure through its operational contract',
    async (operation) => {
      const { repoRoot, config, state } = await setup();
      const cause = faker.lorem.sentence();
      const module = 'failed-operation.mjs';
      await writeFile(
        path.join(repoRoot, module),
        `export default () => ({
        load: async () => { throw new Error(${JSON.stringify(cause)}); },
        peek: async () => { throw new Error(${JSON.stringify(cause)}); },
        save: async () => { throw new Error(${JSON.stringify(cause)}); },
      });`,
      );
      const store = unwrap(
        await openRunStore({ repoRoot, config: { ...config, runStores: [module] } }),
      );
      const result =
        operation === 'save' ? await store.save(state) : await store[operation](state.runId);
      expect(result.isErr() && result.error).toBeInstanceOf(RunStoreFailed);
      expect(result.isErr() && result.error).toMatchObject({
        _tag: 'ConfigInvalid',
        kind: 'fatal',
        message: `Run store "${module}" failed: ${cause}`,
      });
    },
  );

  it.each(['import', 'factory'] as const)(
    'reports a custom store %s failure during setup',
    async (stage) => {
      const { repoRoot, config } = await setup();
      const cause = faker.lorem.sentence();
      const source =
        stage === 'import'
          ? `throw new Error(${JSON.stringify(cause)});`
          : `export default () => { throw new Error(${JSON.stringify(cause)}); };`;
      const module = 'failed-setup.mjs';
      await writeFile(path.join(repoRoot, module), source);
      const result = await openRunStore({ repoRoot, config: { ...config, runStores: [module] } });
      expect(result.isErr() && result.error).toBeInstanceOf(RunStoreSetupInvalid);
      expect(result.isErr() && result.error).toMatchObject({
        _tag: 'ConfigInvalid',
        kind: 'fatal',
        message: `Run store "${module}" failed: ${cause}`,
      });
    },
  );

  async function commitOn(repo: string, branch: string) {
    const git = simpleGit(repo);
    await git.checkout(['-b', branch]);
    await writeFile(path.join(repo, `${faker.string.alpha(10)}.txt`), faker.lorem.paragraph());
    await git.add('.');
    await git.commit(faker.git.commitMessage());
    const head = await git.revparse(['HEAD']);
    await git.checkout('main');
    return head;
  }

  async function setup() {
    const { cloneOf } = await createRemote();
    const repoRoot = await cloneOf();
    return {
      repoRoot,
      cloneOf,
      config: repositoryConfig(repoRoot),
      state: aRunState(),
      deferred: aRunState({ codePublication: 'deferred' }),
    };
  }
});
