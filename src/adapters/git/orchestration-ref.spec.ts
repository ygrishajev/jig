import { faker } from '@faker-js/faker';
import { panic } from 'better-result';
import { execFileSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import {
  acceptRequest,
  emptyOrchestration,
  OWNERSHIP_LEASE_MS,
} from '../../domain/orchestration.js';
import type { HeldPublication } from '../../ports/publication-receipts.js';
import { GitOrchestrationStore } from './orchestration-ref.js';
import { RemoteRef } from './remote-ref.js';

describe('GitOrchestrationStore', () => {
  it('starts empty and skips a push for unchanged state', async () => {
    const { dir, store } = await setup();
    expect(unwrap(await store.read())).toEqual(emptyOrchestration());
    unwrap(await store.update((state) => state));
    expect(await simpleGit(dir).listRemote(['origin', 'refs/jig/_orchestration'])).toBe('');
  });

  it('retains concurrent updates from another clone and coexists with run refs', async () => {
    const { dir, cloneOf, store, request } = await setup();
    const second = new GitOrchestrationStore(await cloneOf());
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

  it('grants a free lease and refuses another job while it is unexpired', async () => {
    const { cloneOf } = await setup();
    const now = faker.number.int({ min: 1, max: 1_000_000 });
    const first = new GitOrchestrationStore(await cloneOf(), () => now);
    const second = new GitOrchestrationStore(await cloneOf(), () => now + OWNERSHIP_LEASE_MS - 1);
    const key = faker.string.uuid();

    const held = unwrap(await first.claim(key));

    expect(held?.key).toBe(key);
    expect(unwrap(await second.claim(key))).toBeUndefined();
    expect(unwrap(await second.read()).owners[key]?.token).toBe(held?.token);
  });

  it('hands an expired lease to the next job, whose renewal the first job then loses', async () => {
    const { cloneOf } = await setup();
    const now = faker.number.int({ min: 1, max: 1_000_000 });
    const crashed = new GitOrchestrationStore(await cloneOf(), () => now);
    const later = new GitOrchestrationStore(await cloneOf(), () => now + OWNERSHIP_LEASE_MS);
    const key = faker.string.uuid();
    const abandoned = unwrap(await crashed.claim(key));

    const taken = unwrap(await later.claim(key));

    expect(taken?.token).not.toBe(abandoned?.token);
    expect(unwrap(await crashed.renew(aHeld(abandoned)))).toBe(false);
    expect(unwrap(await later.renew(aHeld(taken)))).toBe(true);
  });

  it('extends a renewed lease from the time of renewal', async () => {
    const { cloneOf } = await setup();
    const clock = { now: faker.number.int({ min: 1, max: 1_000_000 }) };
    const store = new GitOrchestrationStore(await cloneOf(), () => clock.now);
    const key = faker.string.uuid();
    const held = aHeld(unwrap(await store.claim(key)));
    clock.now += faker.number.int({ min: 1, max: OWNERSHIP_LEASE_MS });

    unwrap(await store.renew(held));

    expect(unwrap(await store.read()).owners[key]).toEqual({
      token: held.token,
      expiresAt: clock.now + OWNERSHIP_LEASE_MS,
    });
  });

  it("releases only its own lease and leaves another job's in place", async () => {
    const { store, cloneOf } = await setup();
    const other = new GitOrchestrationStore(await cloneOf());
    const [mine, theirs] = [faker.string.uuid(), faker.string.uuid()];
    const held = aHeld(unwrap(await store.claim(mine)));
    const otherHeld = aHeld(unwrap(await other.claim(theirs)));

    unwrap(await store.release(held));
    unwrap(await store.release({ key: theirs, token: held.token }));

    expect(unwrap(await store.read()).owners).toEqual({
      [theirs]: expect.objectContaining({ token: otherHeld.token }),
    });
  });

  async function setup() {
    const { cloneOf, origin } = await createRemote();
    const dir = await cloneOf();
    return {
      dir,
      origin,
      cloneOf,
      store: new GitOrchestrationStore(dir),
      request: { runId: runId(), text: faker.lorem.paragraph(), title: faker.lorem.sentence() },
    };
  }
});

function aHeld(held: HeldPublication | undefined): HeldPublication {
  if (!held) panic('Expected the claim to grant the lease');
  return held;
}
