import { faker } from '@faker-js/faker';
import { Panic, panic, Result } from 'better-result';
import { execFileSync } from 'node:child_process';
import { pino } from 'pino';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { exceptionDetails } from '../../adapters/exception-details.js';
import { RemoteRef } from '../../adapters/git/remote-ref.js';
import { retryResult } from '../../adapters/retry.js';
import { GithubRefused } from './errors.js';
import { acceptRequest, claimPublication, emptyOrchestration } from './orchestration-state.js';
import { OrchestrationStore, OWNERSHIP_LEASE_MS } from './orchestration-store.js';

describe('OrchestrationStore', () => {
  it('starts empty and skips a push for unchanged state', async () => {
    const { dir, store } = await setup();
    expect(unwrap(await store.read())).toEqual(emptyOrchestration());
    unwrap(await store.update((state) => state));
    expect(await simpleGit(dir).listRemote(['origin', 'refs/jig/_orchestration'])).toBe('');
  });

  it('retains concurrent updates from another clone and coexists with run refs', async () => {
    const { dir, cloneOf, store, request } = await setup();
    const second = new OrchestrationStore(await cloneOf(), retryResult, exceptionDetails);
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

  it('refuses a second owner while the first publishes, and releases however the work ends', async () => {
    const { store, cloneOf } = await setup();
    const other = new OrchestrationStore(await cloneOf(), retryResult, exceptionDetails);
    const key = faker.string.uuid();
    const value = faker.lorem.word();
    const failure = new GithubRefused({ message: faker.lorem.sentence() });
    const logger = pino({ level: 'silent' });

    const outer = await store.withPublicationOwnership(key, logger, async () => {
      const inner = await other.withPublicationOwnership(key, logger, async () => Result.ok());
      expect(inner.isErr() && inner.error._tag).toBe('PublicationInProgress');
      return Result.ok(value);
    });
    const failed = await other.withPublicationOwnership(key, logger, async () =>
      Result.err(failure),
    );
    const after = await store.withPublicationOwnership(key, logger, async () => Result.ok(value));

    expect(unwrap(outer)).toBe(value);
    expect(failed.isErr() && failed.error).toBe(failure);
    expect(unwrap(after)).toBe(value);
    expect(unwrap(await store.read()).owners).toEqual({});
  });

  it('takes over a lease a crashed owner left once it expires', async () => {
    const { dir, cloneOf } = await setup();
    const key = faker.string.uuid();
    const now = faker.number.int({ min: 1, max: 1_000_000 });
    const crashed = { token: faker.string.uuid(), expiresAt: now + 1 };
    unwrap(
      await new OrchestrationStore(dir, retryResult, exceptionDetails).update((state) =>
        claimPublication(state, key, crashed, now),
      ),
    );
    const logger = pino({ level: 'silent' });
    const value = faker.lorem.word();

    const early = await new OrchestrationStore(
      await cloneOf(),
      retryResult,
      exceptionDetails,
      () => now,
    ).withPublicationOwnership(key, logger, async () => Result.ok(value));
    const late = await new OrchestrationStore(
      await cloneOf(),
      retryResult,
      exceptionDetails,
      () => crashed.expiresAt,
    ).withPublicationOwnership(key, logger, async () => Result.ok(value));

    expect(early.isErr() && early.error._tag).toBe('PublicationInProgress');
    expect(unwrap(late)).toBe(value);
  });

  it('stops a publisher whose lease another job took over before its next effect', async () => {
    const { cloneOf } = await setup();
    const clock = { now: faker.number.int({ min: 1, max: 1_000_000 }) };
    const slow = new OrchestrationStore(
      await cloneOf(),
      retryResult,
      exceptionDetails,
      () => clock.now,
    );
    const other = new OrchestrationStore(
      await cloneOf(),
      retryResult,
      exceptionDetails,
      () => clock.now,
    );
    const key = faker.string.uuid();
    const logger = pino({ level: 'silent' });
    const effects: string[] = [];

    const stopped = await slow.withPublicationOwnership(key, logger, async (whileOwned) => {
      clock.now += OWNERSHIP_LEASE_MS;
      const takeover = await other.withPublicationOwnership(key, logger, (otherOwned) =>
        otherOwned(async () => Result.ok(effects.push('other'))),
      );
      unwrap(takeover);
      return whileOwned(async () => Result.ok(effects.push('slow')));
    });

    expect(stopped.isErr() && stopped.error._tag).toBe('PublicationInProgress');
    expect(effects).toEqual(['other']);
  });

  it('keeps a renewed lease past its first expiry, so no other job can take over', async () => {
    const { cloneOf } = await setup();
    const clock = { now: faker.number.int({ min: 1, max: 1_000_000 }) };
    const slow = new OrchestrationStore(
      await cloneOf(),
      retryResult,
      exceptionDetails,
      () => clock.now,
    );
    const other = new OrchestrationStore(
      await cloneOf(),
      retryResult,
      exceptionDetails,
      () => clock.now,
    );
    const key = faker.string.uuid();
    const logger = pino({ level: 'silent' });
    const value = faker.lorem.word();

    const finished = await slow.withPublicationOwnership(key, logger, async (whileOwned) => {
      clock.now += OWNERSHIP_LEASE_MS - 1;
      unwrap(await whileOwned(async () => Result.ok()));
      clock.now += OWNERSHIP_LEASE_MS - 1;
      const refused = await other.withPublicationOwnership(key, logger, async () => Result.ok());
      expect(refused.isErr() && refused.error._tag).toBe('PublicationInProgress');
      return whileOwned(async () => Result.ok(value));
    });

    expect(unwrap(finished)).toBe(value);
  });

  it('releases ownership when the publisher panics and rethrows the panic', async () => {
    const { store, cloneOf } = await setup();
    const other = new OrchestrationStore(await cloneOf(), retryResult, exceptionDetails);
    const key = faker.string.uuid();
    const message = faker.lorem.sentence();
    const value = faker.lorem.word();
    const logger = pino({ level: 'silent' });

    const failed = store.withPublicationOwnership(key, logger, async () => panic(message));

    await expect(failed).rejects.toThrow(Panic);
    await expect(failed).rejects.toThrow(message);
    expect(
      unwrap(await other.withPublicationOwnership(key, logger, async () => Result.ok(value))),
    ).toBe(value);
  });

  async function setup() {
    const { cloneOf, origin } = await createRemote();
    const dir = await cloneOf();
    return {
      dir,
      origin,
      cloneOf,
      store: new OrchestrationStore(dir, retryResult, exceptionDetails),
      request: { runId: runId(), text: faker.lorem.paragraph(), title: faker.lorem.sentence() },
    };
  }
});
