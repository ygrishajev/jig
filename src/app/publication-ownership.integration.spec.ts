import { faker } from '@faker-js/faker';
import { Panic, panic, Result } from 'better-result';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { createRemote } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { GitOrchestrationStore } from '../adapters/git/orchestration-ref.js';
import { RemoteRef } from '../adapters/git/remote-ref.js';
import { claimPublication, OWNERSHIP_LEASE_MS } from '../domain/orchestration.js';
import { GitCommandFailed } from '../ports/git-failures.js';
import { withPublicationOwnership } from './publication-ownership.js';

describe('withPublicationOwnership', () => {
  it('refuses a second owner while the first publishes, and releases however the work ends', async () => {
    const { store, anotherJob, key, logger } = await setup();
    const other = await anotherJob();
    const value = faker.lorem.word();
    const failure = aWorkFailure();

    const outer = await withPublicationOwnership(store, key, logger, async () => {
      const inner = await withPublicationOwnership(other, key, logger, async () => Result.ok());
      expect(inner.isErr() && inner.error._tag).toBe('PublicationInProgress');
      return Result.ok(value);
    });
    const failed = await withPublicationOwnership(other, key, logger, async () =>
      Result.err(failure),
    );
    const after = await withPublicationOwnership(store, key, logger, async () => Result.ok(value));

    expect(unwrap(outer)).toBe(value);
    expect(failed.isErr() && failed.error).toBe(failure);
    expect(unwrap(after)).toBe(value);
    expect(unwrap(await store.read()).owners).toEqual({});
  });

  it('takes over a lease a crashed owner left once it expires', async () => {
    const { store, anotherJob, key, logger } = await setup();
    const now = faker.number.int({ min: 1, max: 1_000_000 });
    const crashed = { token: faker.string.uuid(), expiresAt: now + 1 };
    unwrap(await store.update((state) => claimPublication(state, key, crashed, now)));
    const value = faker.lorem.word();

    const early = await withPublicationOwnership(await anotherJob(() => now), key, logger, () =>
      Promise.resolve(Result.ok(value)),
    );
    const late = await withPublicationOwnership(
      await anotherJob(() => crashed.expiresAt),
      key,
      logger,
      () => Promise.resolve(Result.ok(value)),
    );

    expect(early.isErr() && early.error._tag).toBe('PublicationInProgress');
    expect(unwrap(late)).toBe(value);
  });

  it('stops a publisher whose lease another job took over before its next effect', async () => {
    const { anotherJob, key, logger } = await setup();
    const clock = { now: faker.number.int({ min: 1, max: 1_000_000 }) };
    const slow = await anotherJob(() => clock.now);
    const other = await anotherJob(() => clock.now);
    const effects: string[] = [];

    const stopped = await withPublicationOwnership(slow, key, logger, async (whileOwned) => {
      clock.now += OWNERSHIP_LEASE_MS;
      const takeover = await withPublicationOwnership(other, key, logger, (otherOwned) =>
        otherOwned(async () => Result.ok(effects.push('other'))),
      );
      unwrap(takeover);
      return whileOwned(async () => Result.ok(effects.push('slow')));
    });

    expect(stopped.isErr() && stopped.error._tag).toBe('PublicationInProgress');
    expect(effects).toEqual(['other']);
  });

  it('keeps a renewed lease past its first expiry, so no other job can take over', async () => {
    const { anotherJob, key, logger } = await setup();
    const clock = { now: faker.number.int({ min: 1, max: 1_000_000 }) };
    const slow = await anotherJob(() => clock.now);
    const other = await anotherJob(() => clock.now);
    const value = faker.lorem.word();

    const finished = await withPublicationOwnership(slow, key, logger, async (whileOwned) => {
      clock.now += OWNERSHIP_LEASE_MS - 1;
      unwrap(await whileOwned(async () => Result.ok()));
      clock.now += OWNERSHIP_LEASE_MS - 1;
      const refused = await withPublicationOwnership(other, key, logger, async () => Result.ok());
      expect(refused.isErr() && refused.error._tag).toBe('PublicationInProgress');
      return whileOwned(async () => Result.ok(value));
    });

    expect(unwrap(finished)).toBe(value);
  });

  it('returns the failed release when the work succeeded', async () => {
    const { store, key, logger, corruptReceipts } = await setup();

    const result = await withPublicationOwnership(store, key, logger, async () => {
      await corruptReceipts();
      return Result.ok(faker.lorem.word());
    });

    expect(result.isErr() && result.error._tag).toBe('OrchestrationStateInvalid');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the work failure and logs the failed release that followed it', async () => {
    const { store, key, logger, corruptReceipts } = await setup();
    const failure = aWorkFailure();

    const result = await withPublicationOwnership(store, key, logger, async () => {
      await corruptReceipts();
      return Result.err(failure);
    });

    expect(result.isErr() && result.error).toBe(failure);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [record] = logger.warn.mock.calls[0];
    expect((record as { err: { _tag: string } }).err._tag).toBe('OrchestrationStateInvalid');
  });

  it('releases ownership when the publisher panics and rethrows the panic', async () => {
    const { store, anotherJob, key, logger } = await setup();
    const message = faker.lorem.sentence();
    const value = faker.lorem.word();

    const failed = withPublicationOwnership(store, key, logger, async () => panic(message));

    await expect(failed).rejects.toThrow(Panic);
    await expect(failed).rejects.toThrow(message);
    expect(
      unwrap(
        await withPublicationOwnership(await anotherJob(), key, logger, async () =>
          Result.ok(value),
        ),
      ),
    ).toBe(value);
  });

  async function setup() {
    const { cloneOf } = await createRemote();
    const dir = await cloneOf();
    const anotherJob = async (now?: () => number) =>
      new GitOrchestrationStore(await cloneOf(), now);
    const corruptReceipts = async () => {
      const refs = new RemoteRef(dir);
      const ref = 'refs/jig/_orchestration';
      const expected = unwrap(await refs.list([ref])).get(ref);
      const commit = unwrap(
        await refs.commitFile(ref, 'orchestration.json', '{}', faker.git.commitMessage()),
      );
      unwrap(await refs.pushLeased([{ ref, source: commit, expected }]));
    };
    return {
      store: new GitOrchestrationStore(dir),
      anotherJob,
      corruptReceipts,
      key: faker.string.uuid(),
      logger: mock<Logger>(),
    };
  }
});

function aWorkFailure() {
  return new GitCommandFailed({
    message: faker.lorem.sentence(),
    command: faker.lorem.word(),
    output: faker.lorem.sentence(),
  });
}
