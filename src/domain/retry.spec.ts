import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { describe, expect, it, vi } from 'vitest';

import { runSettings } from '../../tests/support/builders.js';
import { retryResult } from '../failures/retry.js';
import { AgentRunFailed, type JigError, MergeFailed } from './errors.js';
import { transientRetryPolicy } from './retry.js';

describe('transientRetryPolicy', () => {
  it("takes its retries and delay from the run's settings", () => {
    const maxStepRetries = faker.number.int({ min: 0, max: 5 });
    const retryDelayMs = faker.number.int({ min: 6000, max: 60_000 });

    const policy = setup({ maxStepRetries, retryDelayMs });

    expect(policy).toMatchObject({ retries: maxStepRetries, delayMs: retryDelayMs });
  });

  it('accepts a failure worth another attempt and refuses one that needs a person', () => {
    const policy = setup();

    expect(policy.shouldRetry(new AgentRunFailed({ message: faker.lorem.sentence() }))).toBe(true);
    expect(policy.shouldRetry(new MergeFailed({ message: faker.lorem.sentence() }))).toBe(false);
  });

  it('lets retryResult try a transient failure until the settings budget runs out', async () => {
    const maxStepRetries = faker.number.int({ min: 1, max: 3 });
    const failure = new AgentRunFailed({ message: faker.lorem.sentence() });
    const operation = vi.fn(async (): Promise<Result<string, JigError>> => Result.err(failure));

    const result = await retryResult(operation, setup({ maxStepRetries, retryDelayMs: 0 }));

    expect(result.isErr() && result.error).toBe(failure);
    expect(operation).toHaveBeenCalledTimes(maxStepRetries + 1);
  });

  function setup(input: { maxStepRetries?: number; retryDelayMs?: number } = {}) {
    return transientRetryPolicy(runSettings(input));
  }
});
