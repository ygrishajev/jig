import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { runSettings } from '../../tests/support/builders.js';
import { transientRetryPolicy } from './retry-policy.js';

describe('transientRetryPolicy', () => {
  it("takes its retries and delay from the run's settings", () => {
    const maxStepRetries = faker.number.int({ min: 0, max: 5 });
    const retryDelayMs = faker.number.int({ min: 6000, max: 60_000 });

    const policy = setup({ maxStepRetries, retryDelayMs });

    expect(policy).toMatchObject({ retries: maxStepRetries, delayMs: retryDelayMs });
  });

  it('accepts a failure worth another attempt', () => {
    expect(setup().shouldRetry({ kind: 'retry' })).toBe(true);
  });

  it('refuses a failure that needs a person or ends the run', () => {
    const policy = setup();

    expect(policy.shouldRetry({ kind: 'block' })).toBe(false);
    expect(policy.shouldRetry({ kind: 'fatal' })).toBe(false);
  });

  it('leaves reporting a failed attempt to its caller', () => {
    expect(setup().onFailedAttempt).toBeUndefined();
  });

  function setup(input: { maxStepRetries?: number; retryDelayMs?: number } = {}) {
    return transientRetryPolicy(runSettings(input));
  }
});
