import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';

import { runSettings } from '../../tests/support/builders.js';
import { AgentRunFailed, type JigError, MergeFailed } from '../domain/errors.js';
import { transientRetryPolicy } from '../domain/retry.js';
import type { RetryPolicy } from '../ports/retry.js';
import { retryResult } from './retry.js';

describe('retryResult', () => {
  it('returns the first success without retrying', async () => {
    const value = faker.lorem.word();
    const { run, operation, onFailedAttempt } = setup({ results: [Result.ok(value)], retries: 3 });

    const result = await run();

    expect(result.isOk() && result.value).toBe(value);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onFailedAttempt).not.toHaveBeenCalled();
  });

  it('makes a single attempt when the policy allows no retries', async () => {
    const error = faker.lorem.word();
    const { run, operation, onFailedAttempt, shouldRetry } = setup({
      results: [Result.err(error), Result.ok(faker.lorem.word())],
      retries: 0,
    });

    const result = await run();

    expect(result.isErr() && result.error).toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onFailedAttempt).toHaveBeenCalledWith({ error, attempt: 1, retriesLeft: 0 });
    expect(shouldRetry).not.toHaveBeenCalled();
  });

  it('retries a retryable failure until it succeeds', async () => {
    const value = faker.lorem.word();
    const { run, operation } = setup({
      results: [Result.err(faker.lorem.word()), Result.err(faker.lorem.word()), Result.ok(value)],
      retries: 3,
    });

    const result = await run();

    expect(result.isOk() && result.value).toBe(value);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last retry with the last failure', async () => {
    const errors = [faker.lorem.word(), faker.lorem.word(), faker.lorem.word()];
    const { run, operation } = setup({ results: errors.map((e) => Result.err(e)), retries: 2 });

    const result = await run();

    expect(result.isErr() && result.error).toBe(errors[2]);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('stops at a failure the policy refuses, after asking about that failure', async () => {
    const error = faker.lorem.word();
    const { run, operation, shouldRetry } = setup({
      results: [Result.err(error), Result.ok(faker.lorem.word())],
      retries: 3,
      retryable: false,
    });

    const result = await run();

    expect(result.isErr() && result.error).toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(shouldRetry.mock.calls).toEqual([[error]]);
  });

  it('reports each failed attempt with the retries left, before deciding on a retry', async () => {
    const errors = [faker.lorem.word(), faker.lorem.word(), faker.lorem.word()];
    const calls: string[] = [];
    const { run, onFailedAttempt } = setup({
      results: errors.map((e) => Result.err(e)),
      retries: 2,
      calls,
    });

    await run();

    expect(onFailedAttempt.mock.calls.map(([failure]) => failure)).toEqual([
      { error: errors[0], attempt: 1, retriesLeft: 2 },
      { error: errors[1], attempt: 2, retriesLeft: 1 },
      { error: errors[2], attempt: 3, retriesLeft: 0 },
    ]);
    expect(calls).toEqual([
      'operation',
      'onFailedAttempt',
      'shouldRetry',
      'operation',
      'onFailedAttempt',
      'shouldRetry',
      'operation',
      'onFailedAttempt',
    ]);
  });

  it('doubles the wait before each further attempt', async () => {
    const delayMs = 20;
    const startedAt: number[] = [];
    const operation = async (): Promise<Result<string, string>> => {
      startedAt.push(performance.now());
      return Result.err(faker.lorem.word());
    };

    await retryResult(operation, { retries: 3, delayMs, shouldRetry: () => true });

    const waits = startedAt.slice(1).map((time, index) => time - startedAt[index]!);
    const timerTolerance = 1;
    expect(waits).toHaveLength(3);
    waits.forEach((wait, index) =>
      expect(wait).toBeGreaterThanOrEqual(delayMs * 2 ** index - timerTolerance),
    );
  });

  it('lets a thrown bug through without another attempt', async () => {
    const bug = new Error(faker.lorem.sentence());
    const operation = vi.fn(() => Promise.reject(bug));

    const result = retryResult<string, string>(operation, {
      retries: 2,
      delayMs: 0,
      shouldRetry: () => true,
    });

    await expect(result).rejects.toBe(bug);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('applies the transient policy until the settings budget runs out', async () => {
    const maxStepRetries = faker.number.int({ min: 1, max: 3 });
    const failure = new AgentRunFailed({ message: faker.lorem.sentence() });
    const operation = vi.fn(async (): Promise<Result<string, JigError>> => Result.err(failure));

    const result = await retryResult(
      operation,
      transientRetryPolicy(runSettings({ maxStepRetries, retryDelayMs: 0 })),
    );

    expect(result.isErr() && result.error).toBe(failure);
    expect(operation).toHaveBeenCalledTimes(maxStepRetries + 1);
  });

  it('returns a failure the transient policy refuses after one attempt', async () => {
    const failure = new MergeFailed({ message: faker.lorem.sentence() });
    const operation = vi.fn(async (): Promise<Result<string, JigError>> => Result.err(failure));

    const result = await retryResult(
      operation,
      transientRetryPolicy(runSettings({ maxStepRetries: 2, retryDelayMs: 0 })),
    );

    expect(result.isErr() && result.error).toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  function setup(input: {
    results: Result<string, string>[];
    retries: number;
    retryable?: boolean;
    calls?: string[];
  }) {
    const calls = input.calls ?? [];
    const queue = [...input.results];
    const operation = vi.fn(async () => {
      calls.push('operation');
      return queue.shift() as Result<string, string>;
    });
    const onFailedAttempt = vi.fn<NonNullable<RetryPolicy<string>['onFailedAttempt']>>(() => {
      calls.push('onFailedAttempt');
    });
    const shouldRetry = vi.fn((_error: string) => {
      calls.push('shouldRetry');
      return input.retryable ?? true;
    });
    const run = () =>
      retryResult(operation, { retries: input.retries, delayMs: 0, shouldRetry, onFailedAttempt });
    return { run, operation, onFailedAttempt, shouldRetry };
  }
});
