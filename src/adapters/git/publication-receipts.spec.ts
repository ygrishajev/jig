import { faker } from '@faker-js/faker';
import { execFileSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { acceptRequest, emptyOrchestration } from '../../domain/github-orchestration.js';
import { RemotePublicationReceipts } from './publication-receipts.js';
import { RemoteRef } from './remote-ref.js';

describe('RemotePublicationReceipts', () => {
  it('starts empty and skips a push for unchanged state', async () => {
    const { dir, store } = await setup();
    expect(unwrap(await store.read())).toEqual(emptyOrchestration());
    unwrap(await store.update((state) => state));
    expect(await simpleGit(dir).listRemote(['origin', 'refs/jig/_orchestration'])).toBe('');
  });

  it('saves the orchestration as formatted JSON in the hidden ref that another clone reads', async () => {
    const { dir, cloneOf, store, request } = await setup();
    const key = faker.string.uuid();
    const owner = { token: faker.string.uuid(), expiresAt: faker.number.int() };

    const saved = unwrap(
      await store.update((state) => ({
        ...acceptRequest(state, key, request),
        owners: { [key]: owner },
      })),
    );

    expect(await simpleGit(dir).show([`refs/jig/_orchestration:orchestration.json`])).toBe(
      `${JSON.stringify(saved, null, 2)}\n`,
    );
    expect(unwrap(await new RemotePublicationReceipts(await cloneOf()).read())).toEqual(saved);
  });

  it('retains concurrent updates from another clone and coexists with run refs', async () => {
    const { dir, cloneOf, store, request } = await setup();
    const second = new RemotePublicationReceipts(await cloneOf());
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

  it('names the orchestration ref when competing jobs exhaust the retry budget', async () => {
    const { dir, origin, store, request } = await setup();
    const refs = new RemoteRef(dir);
    const key = faker.string.uuid();
    const commits: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = acceptRequest(emptyOrchestration(), faker.string.uuid(), request);
      commits.push(
        unwrap(
          await refs.commitFile(
            'refs/jig/_orchestration',
            'orchestration.json',
            JSON.stringify(state),
            faker.git.commitMessage(),
          ),
        ),
      );
    }
    let attempts = 0;
    const result = await store.update((state) => {
      execFileSync(
        'git',
        ['push', '--force', origin, `${commits[attempts++]}:refs/jig/_orchestration`],
        { cwd: dir, stdio: 'pipe' },
      );
      return acceptRequest(state, key, request);
    });
    expect(attempts).toBe(5);
    expect(result.isErr() && result.error._tag).toBe('OrchestrationStateInvalid');
    expect(result.isErr() && result.error.message).toContain('refs/jig/_orchestration');
    expect(result.isErr() && result.error.message).toContain('Competing jobs');
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
    const { cloneOf, origin } = await createRemote();
    const dir = await cloneOf();
    return {
      dir,
      origin,
      cloneOf,
      store: new RemotePublicationReceipts(dir),
      request: { runId: runId(), text: faker.lorem.paragraph(), title: faker.lorem.sentence() },
    };
  }
});
