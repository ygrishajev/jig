import { faker } from '@faker-js/faker';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { RemoteRef } from '../../adapters/git/remote-ref.js';
import { acceptRequest, emptyOrchestration } from './orchestration-state.js';
import { OrchestrationStore } from './orchestration-store.js';

describe('OrchestrationStore', () => {
  it('starts empty and skips a push for unchanged state', async () => {
    const { dir, store } = await setup();
    expect(unwrap(await store.read())).toEqual(emptyOrchestration());
    unwrap(await store.update((state) => state));
    expect(await simpleGit(dir).listRemote(['origin', 'refs/jig/_orchestration'])).toBe('');
  });

  it('retains concurrent updates from another clone and coexists with run refs', async () => {
    const { dir, cloneOf, store, request } = await setup();
    const second = new OrchestrationStore(await cloneOf());
    const id = runId();
    const refs = new RemoteRef(dir);
    const runRef = `refs/jig/${id}`;
    const commit = unwrap(
      await refs.commitFile(runRef, 'run.json', faker.lorem.paragraph(), faker.git.commitMessage()),
    );
    unwrap(await refs.pushLeased([{ ref: runRef, source: commit }]));
    const keys = [faker.string.uuid(), faker.string.uuid()];
    const results = await Promise.all([
      store.update((state) => acceptRequest(state, keys[0], request)),
      second.update((state) => acceptRequest(state, keys[1], request)),
    ]);
    results.forEach(unwrap);
    const state = unwrap(await store.read());
    expect(Object.keys(state.requests).sort()).toEqual(keys.sort());
    expect(unwrap(await refs.list([runRef])).get(runRef)).toBe(commit);
    const before = await simpleGit(dir).listRemote(['origin', 'refs/jig/_orchestration']);
    unwrap(await store.update((state) => ({ ...state })));
    expect(await simpleGit(dir).listRemote(['origin', 'refs/jig/_orchestration'])).toBe(before);
  });

  it('refuses corrupt remote state', async () => {
    const { dir, store } = await setup();
    const refs = new RemoteRef(dir);
    const commit = unwrap(
      await refs.commitFile(
        'refs/jig/_orchestration',
        'orchestration.json',
        '{}',
        faker.git.commitMessage(),
      ),
    );
    unwrap(await refs.pushLeased([{ ref: 'refs/jig/_orchestration', source: commit }]));
    const result = await store.read();
    expect(result.isErr() && result.error._tag).toBe('OrchestrationStateInvalid');
  });

  async function setup() {
    const { cloneOf } = await createRemote();
    const dir = await cloneOf();
    return {
      dir,
      cloneOf,
      store: new OrchestrationStore(dir),
      request: { runId: runId(), text: faker.lorem.paragraph(), title: faker.lorem.sentence() },
    };
  }
});
