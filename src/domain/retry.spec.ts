import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { runSettings } from '../../tests/support/builders.js';
import { AgentRunFailed, MergeFailed } from './errors.js';
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

  function setup(input: { maxStepRetries?: number; retryDelayMs?: number } = {}) {
    return transientRetryPolicy(runSettings(input));
  }
});
