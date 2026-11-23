import { faker } from '@faker-js/faker';
import { Panic, panic, Result } from 'better-result';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { unwrap } from '../../tests/support/unwrap.js';
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
