import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { describe, expect, it, vi } from 'vitest';

import { retryResult } from './retry.js';

describe('retryResult', () => {
  it('returns the first success without retrying', async () => {
    const value = faker.lorem.word();
    const { run, operation } = setup({ results: [Result.ok(value)], retries: 3 });

    const result = await run();

    expect(result).toEqual(Result.ok(value));
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure until it succeeds', async () => {
    const value = faker.lorem.word();
    const { run, operation } = setup({
      results: [Result.err(faker.lorem.word()), Result.err(faker.lorem.word()), Result.ok(value)],
      retries: 3,
    });

    const result = await run();

    expect(result).toEqual(Result.ok(value));
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last retry with the last failure', async () => {
    const errors = [faker.lorem.word(), faker.lorem.word(), faker.lorem.word()];
    const { run, operation } = setup({ results: errors.map((e) => Result.err(e)), retries: 2 });

    const result = await run();

    expect(result.isErr() && result.error).toBe(errors[2]);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('stops at a failure it should not retry', async () => {
    const error = faker.lorem.word();
    const { run, operation } = setup({
      results: [Result.err(error), Result.ok(faker.lorem.word())],
      retries: 3,
      retryable: false,
    });

    const result = await run();

    expect(result.isErr() && result.error).toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('reports each failed attempt with the retries left', async () => {
    const errors = [faker.lorem.word(), faker.lorem.word(), faker.lorem.word()];
    const { run, onFailedAttempt } = setup({
      results: errors.map((e) => Result.err(e)),
      retries: 2,
    });

    await run();

    expect(onFailedAttempt.mock.calls.map(([failure]) => failure)).toEqual([
      { error: errors[0], attempt: 1, retriesLeft: 2 },
      { error: errors[1], attempt: 2, retriesLeft: 1 },
      { error: errors[2], attempt: 3, retriesLeft: 0 },
    ]);
  });

  it('waits twice as long before each further attempt', async () => {
    const delayMs = faker.number.int({ min: 20, max: 30 });
    const startedAt: number[] = [];
    const operation = async (): Promise<Result<string, string>> => {
      startedAt.push(performance.now());
      return Result.err(faker.lorem.word());
    };

    await retryResult(operation, { retries: 2, delayMs, shouldRetry: () => true });

    expect(startedAt).toHaveLength(3);
    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(delayMs - 1);
    expect(startedAt[2]! - startedAt[1]!).toBeGreaterThanOrEqual(2 * delayMs - 1);
  });

  it('lets a thrown bug through', async () => {
    const bug = new Error(faker.lorem.sentence());

    const result = retryResult<string, string>(() => Promise.reject(bug), {
      retries: 2,
      delayMs: 0,
      shouldRetry: () => true,
    });

    await expect(result).rejects.toBe(bug);
  });

  function setup(input: {
    results: Result<string, string>[];
    retries: number;
    retryable?: boolean;
  }) {
    const queue = [...input.results];
    const operation = vi.fn(async () => queue.shift() as Result<string, string>);
    const onFailedAttempt = vi.fn();
    const run = () =>
      retryResult(operation, {
        retries: input.retries,
        delayMs: 0,
        shouldRetry: () => input.retryable ?? true,
        onFailedAttempt,
      });
    return { run, operation, onFailedAttempt };
  }
});
