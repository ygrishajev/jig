import { faker } from '@faker-js/faker';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { aRunState } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { RunStateInvalid } from '../../ports/run-state-failures.js';
import { RunStoreOperationFailed, RunStoreSetupInvalid } from '../../ports/run-store.js';
import { RepositoryRunStores } from './repository-run-stores.js';

describe('RepositoryRunStores', () => {
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
    const name = 'load-only-store.mjs';

    const store = unwrap(await new RepositoryRunStores(repoRoot).storeNamed(name));

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
    const name = 'file-store.mjs';
    const state = aRunState();

    await unwrap(await new RepositoryRunStores(repoRoot).storeNamed(name)).save(state);

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
      const name = 'empty-store.mjs';

      const store = unwrap(await new RepositoryRunStores(repoRoot).storeNamed(name));

      expect((await store.load(aRunState().runId)).unwrap()).toBeUndefined();
    },
  );

  it('refuses a run a module store hands back that is not a run', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    await writeFile(
      path.join(repoRoot, 'broken-store.mjs'),
      `export default () => ({ load: async () => ({ phase: 'nowhere' }), save: async () => {} });`,
    );
    const name = 'broken-store.mjs';
    const store = unwrap(await new RepositoryRunStores(repoRoot).storeNamed(name));

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
    const name = 'throwing-store.mjs';
    const store = unwrap(await new RepositoryRunStores(repoRoot).storeNamed(name));

    const loaded = await store.load(aRunState().runId);

    expect(loaded.isErr() && loaded.error).toBeInstanceOf(RunStoreOperationFailed);
    expect(loaded.isErr() && loaded.error.message).toBe(
      'Run store "throwing-store.mjs" failed: disk on fire',
    );
  });

  it('reports a store module whose save throws as a failed store operation', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    const reason = faker.lorem.words(3);
    await writeFile(
      path.join(repoRoot, 'unsaving-store.mjs'),
      `export default () => ({
         load: async () => undefined,
         save: async () => { throw new Error(${JSON.stringify(reason)}); },
       });`,
    );
    const name = 'unsaving-store.mjs';
    const store = unwrap(await new RepositoryRunStores(repoRoot).storeNamed(name));

    const saved = await store.save(aRunState());

    expect(saved.isErr() && saved.error).toBeInstanceOf(RunStoreOperationFailed);
    expect(saved.isErr() && saved.error.message).toBe(
      `Run store "unsaving-store.mjs" failed: ${reason}`,
    );
  });

  it('refuses a store module whose factory throws, as a store it cannot set up', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    const reason = faker.lorem.words(3);
    await writeFile(
      path.join(repoRoot, 'exploding-store.mjs'),
      `export default () => { throw new Error(${JSON.stringify(reason)}); };`,
    );
    const name = 'exploding-store.mjs';

    const opened = await new RepositoryRunStores(repoRoot).storeNamed(name);

    expect(opened.isErr() && opened.error).toBeInstanceOf(RunStoreSetupInvalid);
    expect(opened.isErr() && opened.error.message).toBe(
      `Run store "exploding-store.mjs" failed: ${reason}`,
    );
  });

  it('refuses a module whose factory does not return a store with load and save', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    await writeFile(
      path.join(repoRoot, 'half-a-store.mjs'),
      'export default () => ({ load: async () => undefined });',
    );
    const name = 'half-a-store.mjs';

    const opened = await new RepositoryRunStores(repoRoot).storeNamed(name);

    expect(opened.isErr() && opened.error).toBeInstanceOf(RunStoreSetupInvalid);
    expect(opened.isErr() && opened.error.message).toBe(
      'Run store "half-a-store.mjs" must return an object with load and save methods.',
    );
  });

  it('refuses a module that does not export a store factory', async () => {
    const repoRoot = await tempDirectory('jig-stores-');
    await writeFile(path.join(repoRoot, 'not-a-store.mjs'), 'export const store = {};');
    const name = 'not-a-store.mjs';

    const opened = await new RepositoryRunStores(repoRoot).storeNamed(name);

    expect(opened.isErr() && opened.error).toBeInstanceOf(RunStoreSetupInvalid);
  });
});
