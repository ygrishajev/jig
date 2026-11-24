import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { unwrap } from '../../tests/support/unwrap.js';
import { GitCommandFailed } from '../ports/git-failures.js';
import type { WarningLog } from '../ports/observability.js';
import { releaseInOrder, withResource } from './lifecycle.js';

describe('withResource', () => {
  it('hands the work what was acquired and releases it once the work is done', async () => {
    const { use, events, acquired } = setup();
    const value = faker.lorem.word();

    const used = await use(async (resource) => {
      events.push(`use ${resource}`);
      return Result.ok(value);
    });

    expect(unwrap(used)).toBe(value);
    expect(events).toEqual(['acquire', `use ${acquired}`, 'release']);
  });

  it('neither works nor releases when nothing was acquired', async () => {
    const acquireFailure = aGitCommandFailed();
    const { use, events } = setup({ acquireFailure });

    const used = await use(async () => Result.ok(faker.lorem.word()));

    expect(used.isErr() && used.error).toBe(acquireFailure);
    expect(events).toEqual(['acquire']);
  });

  it('fails with the release once the work succeeded', async () => {
    const releaseFailure = aGitCommandFailed();
    const { use, log } = setup({ releaseFailure });

    const used = await use(async () => Result.ok(faker.lorem.word()));

    expect(used.isErr() && used.error).toBe(releaseFailure);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps the work failure and logs the release that failed after it', async () => {
    const workFailure = aGitCommandFailed();
    const releaseFailure = aGitCommandFailed();
    const { use, loggedFailures } = setup({ releaseFailure });

    const used = await use(async () => Result.err(workFailure));

    expect(used.isErr() && used.error).toBe(workFailure);
    expect(loggedFailures()).toHaveLength(1);
    expect(loggedFailures()[0]).toBe(releaseFailure);
  });

  it('releases after the work panics and passes the panic on as it was thrown', async () => {
    const bug = new Error(faker.lorem.sentence());
    const releaseFailure = aGitCommandFailed();
    const { use, events, loggedFailures } = setup({ releaseFailure });

    const thrown = await use(async () => {
      throw bug;
    }).catch((error: unknown) => error);

    expect(thrown).toBe(bug);
    expect(events).toEqual(['acquire', 'release']);
    expect(loggedFailures()).toHaveLength(1);
    expect(loggedFailures()[0]).toBe(releaseFailure);
  });

  function setup(
    input: { acquireFailure?: GitCommandFailed; releaseFailure?: GitCommandFailed } = {},
  ) {
    const events: string[] = [];
    const acquired = faker.string.alpha(8);
    const log = mock<WarningLog>();
    const lifetime = {
      acquire: async () => {
        events.push('acquire');
        return input.acquireFailure ? Result.err(input.acquireFailure) : Result.ok(acquired);
      },
      release: async () => {
        events.push('release');
        return input.releaseFailure ? Result.err(input.releaseFailure) : Result.ok();
      },
    };
    return {
      acquired,
      events,
      log,
      loggedFailures: () => log.warn.mock.calls.map(([details]) => details.err),
      use: <T, E>(work: (resource: string) => Promise<Result<T, E>>) =>
        withResource(lifetime, log, work),
    };
  }
});

describe('releaseInOrder', () => {
  it('attempts every release in order and returns the first failure, logging the later ones', async () => {
    const failures = [aGitCommandFailed(), aGitCommandFailed()];
    const { release, attempted, loggedFailures } = setup([undefined, failures[0], failures[1]]);

    const released = await release();

    expect(released.isErr() && released.error).toBe(failures[0]);
    expect(attempted()).toEqual([0, 1, 2]);
    expect(loggedFailures()).toHaveLength(1);
    expect(loggedFailures()[0]).toBe(failures[1]);
  });

  it('succeeds when every release did', async () => {
    const { release, attempted, loggedFailures } = setup([undefined, undefined]);

    unwrap(await release());

    expect(attempted()).toEqual([0, 1]);
    expect(loggedFailures()).toHaveLength(0);
  });

  it('still attempts the later releases after one panics, and passes the panic on', async () => {
    const bug = new Error(faker.lorem.sentence());
    const { release, attempted } = setup([bug, undefined]);

    const thrown = await release().catch((error: unknown) => error);

    expect(thrown).toBe(bug);
    expect(attempted()).toEqual([0, 1]);
  });

  function setup(outcomes: (GitCommandFailed | Error | undefined)[]) {
    const attempts: number[] = [];
    const log = mock<WarningLog>();
    const releases = outcomes.map((outcome, index) => async () => {
      attempts.push(index);
      if (outcome instanceof GitCommandFailed) return Result.err(outcome);
      if (outcome) throw outcome;
      return Result.ok();
    });
    return {
      attempted: () => attempts,
      loggedFailures: () => log.warn.mock.calls.map(([details]) => details.err),
      release: () => releaseInOrder<GitCommandFailed>(releases, log),
    };
  }
});

function aGitCommandFailed() {
  return new GitCommandFailed({
    message: faker.lorem.sentence(),
    command: faker.lorem.word(),
    output: faker.lorem.sentence(),
  });
}
