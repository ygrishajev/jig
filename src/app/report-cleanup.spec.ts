import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { GitCommandFailed } from '../domain/errors.js';
import { reportCleanup } from './report-cleanup.js';

describe('reportCleanup', () => {
  it('returns the work result untouched when the cleanup succeeded', () => {
    const value = faker.lorem.word();
    const logger = mock<Logger>();

    const reported = reportCleanup(Result.ok(value), Result.ok(), logger);

    expect(reported.isOk() && reported.value).toBe(value);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports the failed cleanup when the work succeeded', () => {
    const logger = mock<Logger>();
    const cleanup = failedCleanup();

    const reported = reportCleanup(Result.ok(faker.lorem.word()), cleanup, logger);

    expect(reported.isErr() && reported.error).toBe(cleanup.error);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the work failure and logs the cleanup failure that followed it', () => {
    const logger = mock<Logger>();
    const failure = failedCleanup();
    const work = new GitCommandFailed({
      message: faker.lorem.sentence(),
      command: faker.lorem.word(),
      output: faker.lorem.sentence(),
    });

    const reported = reportCleanup(Result.err(work), failure, logger);

    expect(reported.isErr() && reported.error).toBe(work);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [record, message] = logger.warn.mock.calls[0];
    expect((record as { err: unknown }).err).toBe(failure.error);
    expect(message).toBe('cleanup failed after the run failed');
  });
});

function failedCleanup() {
  return Result.err(
    new GitCommandFailed({
      message: faker.lorem.sentence(),
      command: faker.lorem.word(),
      output: faker.lorem.sentence(),
    }),
  );
}
