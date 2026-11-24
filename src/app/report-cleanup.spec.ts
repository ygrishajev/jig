import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { GitCommandFailed } from '../ports/git-failures.js';
import type { WarningLog } from '../ports/observability.js';
import { reportCleanup } from './report-cleanup.js';

describe('reportCleanup', () => {
  it('returns the work result untouched when the cleanup succeeded', () => {
    const { logger, value, reported } = setup();

    expect(reported.isOk() && reported.value).toBe(value);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports the failed cleanup when the work succeeded', () => {
    const cleanup = aGitCommandFailed();
    const { logger, reported } = setup({ cleanupFailure: cleanup });

    expect(reported.isErr() && reported.error).toBe(cleanup);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the work failure and logs the cleanup failure that followed it', () => {
    const work = aGitCommandFailed();
    const cleanup = aGitCommandFailed();
    const { logger, reported } = setup({ workFailure: work, cleanupFailure: cleanup });

    expect(reported.isErr() && reported.error).toBe(work);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [record] = logger.warn.mock.calls[0];
    expect((record as { err: unknown }).err).toBe(cleanup);
  });

  function setup(
    input: { workFailure?: GitCommandFailed; cleanupFailure?: GitCommandFailed } = {},
  ) {
    const logger = mock<WarningLog>();
    const value = faker.lorem.word();
    const work = input.workFailure ? Result.err(input.workFailure) : Result.ok(value);
    const cleanup = input.cleanupFailure ? Result.err(input.cleanupFailure) : Result.ok();
    return { logger, value, reported: reportCleanup(work, cleanup, logger) };
  }
});

function aGitCommandFailed() {
  return new GitCommandFailed({
    message: faker.lorem.sentence(),
    command: faker.lorem.word(),
    output: faker.lorem.sentence(),
  });
}
