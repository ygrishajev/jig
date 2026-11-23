import { faker } from '@faker-js/faker';
import { Panic, panic, Result } from 'better-result';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { createRemote } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { RemotePublicationReceipts } from '../adapters/git/publication-receipts.js';
import {
  claimPublication,
  emptyOrchestration,
  type Orchestration,
} from '../domain/github-orchestration.js';
import { RemoteUnavailable } from '../ports/git-failures.js';
import type { PublicationReceipts, ReceiptsFailure } from '../ports/publication-receipts.js';
import { OWNERSHIP_LEASE_MS, withPublicationOwnership } from './publication-ownership.js';

describe('withPublicationOwnership', () => {
  it('runs the work and releases the lease once it succeeds', async () => {
    const { own, receipts, key } = setup();
    const value = faker.lorem.word();

    const owned = await own(async (whileOwned) => whileOwned(async () => Result.ok(value)));

    expect(unwrap(owned)).toBe(value);
    expect(receipts.state.owners[key]).toBeUndefined();
  });

  it('runs no effect when the claim cannot be saved', async () => {
    const failure = remoteUnavailable();
    const { own, effects } = setup({ failingUpdate: { call: 1, failure } });

    const owned = await own(async (whileOwned) => whileOwned(async () => effects.record()));

    expect(owned.isErr() && owned.error).toBe(failure);
    expect(effects.count).toBe(0);
  });

  it('refuses to take over an unexpired lease another job holds', async () => {
    const { own, receipts, key, effects, clock } = setup();
    const holder = { token: faker.string.uuid(), expiresAt: clock.now() + 1 };
    receipts.state = claimPublication(receipts.state, key, holder, clock.now());

    const owned = await own(async (whileOwned) => whileOwned(async () => effects.record()));

    expect(owned.isErr() && owned.error._tag).toBe('PublicationInProgress');
    expect(effects.count).toBe(0);
    expect(receipts.state.owners[key]).toEqual(holder);
  });

  it('takes over a lease a crashed job left once it expires', async () => {
    const { own, receipts, key, clock } = setup();
    const crashed = { token: faker.string.uuid(), expiresAt: clock.now() };
    receipts.state = claimPublication(receipts.state, key, crashed, clock.now() - 1);
    const value = faker.lorem.word();

    const owned = await own(async (whileOwned) => whileOwned(async () => Result.ok(value)));

    expect(unwrap(owned)).toBe(value);
    expect(receipts.state.owners[key]).toBeUndefined();
  });

  it('stops before the next effect once another job took over the lapsed lease', async () => {
    const { own, receipts, key, clock, effects } = setup();

    const owned = await own(async (whileOwned) => {
      unwrap(await whileOwned(async () => effects.record()));
      clock.advance(OWNERSHIP_LEASE_MS + 1);
      const other = await own(async (otherOwned) => otherOwned(async () => Result.ok()));
      unwrap(other);
      return whileOwned(async () => effects.record());
    });

    expect(owned.isErr() && owned.error._tag).toBe('PublicationInProgress');
    expect(effects.count).toBe(1);
    expect(receipts.state.owners[key]).toBeUndefined();
  });

  it('stops before the next effect when the renewal cannot be saved', async () => {
    const failure = remoteUnavailable();
    const { own, effects } = setup({ failingUpdate: { call: 2, failure } });

    const owned = await own(async (whileOwned) => whileOwned(async () => effects.record()));

    expect(owned.isErr() && owned.error).toBe(failure);
    expect(effects.count).toBe(0);
  });

  it('keeps a renewed lease past its first expiry, so no other job takes over', async () => {
    const { own, clock } = setup();
    const value = faker.lorem.word();

    const owned = await own(async (whileOwned) => {
      clock.advance(OWNERSHIP_LEASE_MS - 1);
      unwrap(await whileOwned(async () => Result.ok()));
      clock.advance(OWNERSHIP_LEASE_MS - 1);
      const refused = await own(async () => Result.ok());
      expect(refused.isErr() && refused.error._tag).toBe('PublicationInProgress');
      return whileOwned(async () => Result.ok(value));
    });

    expect(unwrap(owned)).toBe(value);
  });

  it('returns the release failure in place of a successful result', async () => {
    const failure = remoteUnavailable();
    const { own } = setup({ failingUpdate: { call: 2, failure } });

    const owned = await own(async () => Result.ok(faker.lorem.word()));

    expect(owned.isErr() && owned.error).toBe(failure);
  });

  it('releases the lease after the work returns a failure, so another job can publish', async () => {
    const { own, receipts, key } = setup();
    const workFailure = remoteUnavailable();
    const value = faker.lorem.word();

    const failed = await own(async () => Result.err(workFailure));
    const next = await own(async (whileOwned) => whileOwned(async () => Result.ok(value)));

    expect(failed.isErr() && failed.error).toBe(workFailure);
    expect(unwrap(next)).toBe(value);
    expect(receipts.state.owners[key]).toBeUndefined();
  });

  it('keeps the work failure and logs the release failure when both fail', async () => {
    const releaseFailure = remoteUnavailable();
    const workFailure = remoteUnavailable();
    const { own, logger } = setup({ failingUpdate: { call: 2, failure: releaseFailure } });

    const owned = await own(async () => Result.err(workFailure));

    expect(owned.isErr() && owned.error).toBe(workFailure);
    const loggedFailures = logger.warn.mock.calls.map(
      ([fields]) => (fields as { err: unknown }).err,
    );
    expect(loggedFailures).toHaveLength(1);
    expect(loggedFailures[0]).toBe(releaseFailure);
  });

  it('releases the lease when the work panics and rethrows that panic with its cause', async () => {
    const { own, receipts, key } = setup();
    const message = faker.lorem.sentence();
    const cause = new Error(faker.lorem.sentence());

    const owned = own(async () => panic(message, cause));

    await expect(owned).rejects.toBeInstanceOf(Panic);
    await expect(owned).rejects.toMatchObject({ message, cause });
    expect(receipts.state.owners[key]).toBeUndefined();
  });

  function setup(input: { failingUpdate?: { call: number; failure: ReceiptsFailure } } = {}) {
    const receipts = new InMemoryReceipts(input.failingUpdate);
    let now = faker.number.int({ min: 1, max: 1_000_000 });
    const clock = { now: () => now, advance: (ms: number) => (now += ms) };
    const logger = mock<Logger>();
    const key = faker.string.uuid();
    const effects = {
      count: 0,
      record: async () => Result.ok((effects.count += 1)),
    };
    const own: OwnWork = (use) => withPublicationOwnership({ receipts, clock, logger }, key, use);
    return { own, receipts, clock, logger, key, effects };
  }
});

describe('withPublicationOwnership across clones of one remote', () => {
  it('refuses a second clone while the first publishes, and releases after success and after a failure', async () => {
    const { ownFrom, readOwners } = await setup();
    const first = await ownFrom();
    const second = await ownFrom();
    const value = faker.lorem.word();
    const workFailure = remoteUnavailable();

    const outer = await first(async () => {
      const inner = await second(async () => Result.ok());
      expect(inner.isErr() && inner.error._tag).toBe('PublicationInProgress');
      return Result.ok(value);
    });
    const failed = await second(async () => Result.err(workFailure));
    const after = await first(async (whileOwned) => whileOwned(async () => Result.ok(value)));

    expect(unwrap(outer)).toBe(value);
    expect(failed.isErr() && failed.error).toBe(workFailure);
    expect(unwrap(after)).toBe(value);
    expect(await readOwners()).toEqual({});
  });

  it('takes over a lease a crashed clone left only once it expires', async () => {
    const { ownFrom, clock, key, dir } = await setup();
    const crashed = { token: faker.string.uuid(), expiresAt: clock.now() + 1 };
    unwrap(
      await new RemotePublicationReceipts(dir).update((state) =>
        claimPublication(state, key, crashed, clock.now()),
      ),
    );
    const value = faker.lorem.word();

    const early = await (await ownFrom())(async () => Result.ok(value));
    clock.advance(1);
    const late = await (await ownFrom())(async () => Result.ok(value));

    expect(early.isErr() && early.error._tag).toBe('PublicationInProgress');
    expect(unwrap(late)).toBe(value);
  });

  it('stops a clone whose lapsed lease another clone took over before its next effect', async () => {
    const { ownFrom, clock } = await setup();
    const slow = await ownFrom();
    const other = await ownFrom();
    const effects: string[] = [];

    const stopped = await slow(async (whileOwned) => {
      clock.advance(OWNERSHIP_LEASE_MS);
      unwrap(
        await other(async (otherOwned) => otherOwned(async () => Result.ok(effects.push('other')))),
      );
      return whileOwned(async () => Result.ok(effects.push('slow')));
    });

    expect(stopped.isErr() && stopped.error._tag).toBe('PublicationInProgress');
    expect(effects).toEqual(['other']);
  });

  it('keeps a renewed lease past its first expiry, so another clone cannot take over', async () => {
    const { ownFrom, clock } = await setup();
    const slow = await ownFrom();
    const other = await ownFrom();
    const value = faker.lorem.word();

    const finished = await slow(async (whileOwned) => {
      clock.advance(OWNERSHIP_LEASE_MS - 1);
      unwrap(await whileOwned(async () => Result.ok()));
      clock.advance(OWNERSHIP_LEASE_MS - 1);
      const refused = await other(async () => Result.ok());
      expect(refused.isErr() && refused.error._tag).toBe('PublicationInProgress');
      return whileOwned(async () => Result.ok(value));
    });

    expect(unwrap(finished)).toBe(value);
  });

  it('releases ownership when a clone panics, so another clone can publish', async () => {
    const { ownFrom } = await setup();
    const message = faker.lorem.sentence();
    const cause = new Error(faker.lorem.sentence());
    const value = faker.lorem.word();

    const panicked = (await ownFrom())(async () => panic(message, cause));

    await expect(panicked).rejects.toBeInstanceOf(Panic);
    await expect(panicked).rejects.toMatchObject({ message, cause });
    expect(unwrap(await (await ownFrom())(async () => Result.ok(value)))).toBe(value);
  });

  async function setup() {
    const { cloneOf } = await createRemote();
    const dir = await cloneOf();
    let now = faker.number.int({ min: 1, max: 1_000_000 });
    const clock = { now: () => now, advance: (ms: number) => (now += ms) };
    const key = faker.string.uuid();
    const logger = mock<Logger>();
    const ownFrom = async (): Promise<OwnWork> => {
      const receipts = new RemotePublicationReceipts(await cloneOf());
      return (use) => withPublicationOwnership({ receipts, clock, logger }, key, use);
    };
    const readOwners = async () => unwrap(await new RemotePublicationReceipts(dir).read()).owners;
    return { ownFrom, readOwners, clock, key, dir };
  }
});

type OwnWork = <T, E>(
  use: Parameters<typeof withPublicationOwnership<T, E>>[2],
) => ReturnType<typeof withPublicationOwnership<T, E>>;

function remoteUnavailable(): RemoteUnavailable {
  return new RemoteUnavailable({ message: faker.lorem.sentence() });
}

/** Shared orchestration in memory, failing one scripted update the way the remote ref would. */
class InMemoryReceipts implements PublicationReceipts {
  state: Orchestration = emptyOrchestration();
  private updates = 0;

  constructor(private readonly failingUpdate?: { call: number; failure: ReceiptsFailure }) {}

  async read(): Promise<Result<Orchestration, ReceiptsFailure>> {
    return Result.ok(this.state);
  }

  async update(
    decide: (state: Orchestration) => Orchestration,
  ): Promise<Result<Orchestration, ReceiptsFailure>> {
    this.updates += 1;
    if (this.updates === this.failingUpdate?.call) return Result.err(this.failingUpdate.failure);
    this.state = decide(this.state);
    return Result.ok(this.state);
  }
}
