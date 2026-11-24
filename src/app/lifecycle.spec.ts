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

  it('passes the work panic on and logs a release that panics after it', async () => {
    const bug = new Error(faker.lorem.sentence());
    const cleanupBug = new Error(faker.lorem.sentence());
    const { use, events, loggedFailures } = setup({ releasePanic: cleanupBug });

    const thrown = await use(async () => {
      throw bug;
    }).catch((error: unknown) => error);

    expect(thrown).toBe(bug);
    expect(events).toEqual(['acquire', 'release']);
    expect(loggedFailures()).toEqual([cleanupBug]);
  });

  it('passes a release panic on once the work succeeded', async () => {
    const cleanupBug = new Error(faker.lorem.sentence());
    const { use } = setup({ releasePanic: cleanupBug });

    const thrown = await use(async () => Result.ok(faker.lorem.word())).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBe(cleanupBug);
  });

  function setup(
    input: {
      acquireFailure?: GitCommandFailed;
      releaseFailure?: GitCommandFailed;
      releasePanic?: Error;
    } = {},
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
        if (input.releasePanic) throw input.releasePanic;
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
    const { release, attempted, loggedFailures } = setup({
      outcomes: [undefined, failures[0], failures[1]],
    });

    const released = await release();

    expect(released.isErr() && released.error).toBe(failures[0]);
    expect(attempted()).toEqual([0, 1, 2]);
    expect(loggedFailures()).toHaveLength(1);
    expect(loggedFailures()[0]).toBe(failures[1]);
  });

  it('succeeds when every release did', async () => {
    const { release, attempted, loggedFailures } = setup({ outcomes: [undefined, undefined] });

    unwrap(await release());

    expect(attempted()).toEqual([0, 1]);
    expect(loggedFailures()).toHaveLength(0);
  });

  it('still attempts the later releases after one panics, and passes the panic on', async () => {
    const bug = new Error(faker.lorem.sentence());
    const { release, attempted } = setup({ outcomes: [bug, undefined] });

    const thrown = await release().catch((error: unknown) => error);

    expect(thrown).toBe(bug);
    expect(attempted()).toEqual([0, 1]);
  });

  it('passes the panic on and logs a later release that failed', async () => {
    const bug = new Error(faker.lorem.sentence());
    const failure = aGitCommandFailed();
    const { release, attempted, loggedFailures } = setup({ outcomes: [bug, failure] });

    const thrown = await release().catch((error: unknown) => error);

    expect(thrown).toBe(bug);
    expect(attempted()).toEqual([0, 1]);
    expect(loggedFailures()).toHaveLength(1);
    expect(loggedFailures()[0]).toBe(failure);
  });

  it('passes the panic on and logs an earlier release that failed', async () => {
    const failure = aGitCommandFailed();
    const bug = new Error(faker.lorem.sentence());
    const { release, attempted, loggedFailures } = setup({ outcomes: [failure, bug, undefined] });

    const thrown = await release().catch((error: unknown) => error);

    expect(thrown).toBe(bug);
    expect(attempted()).toEqual([0, 1, 2]);
    expect(loggedFailures()).toHaveLength(1);
    expect(loggedFailures()[0]).toBe(failure);
  });

  it('passes the first panic on and logs every later panic', async () => {
    const bugs = [0, 1, 2].map(() => new Error(faker.lorem.sentence()));
    const { release, attempted, loggedFailures } = setup({ outcomes: bugs });

    const thrown = await release().catch((error: unknown) => error);

    expect(thrown).toBe(bugs[0]);
    expect(attempted()).toEqual([0, 1, 2]);
    expect(loggedFailures()).toEqual([bugs[1], bugs[2]]);
  });

  function setup(input: { outcomes: (GitCommandFailed | Error | undefined)[] }) {
    const attempts: number[] = [];
    const log = mock<WarningLog>();
    const releases = input.outcomes.map((outcome, index) => async () => {
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
