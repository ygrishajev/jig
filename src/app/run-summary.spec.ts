import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aMetricsSummary, tokenUsage } from '../../tests/support/builders.js';
import { formatSummary, progressSummary } from './run-summary.js';

describe('formatSummary', () => {
  it('reads as one line', () => {
    const summary = aMetricsSummary({
      slicesCommitted: 1,
      reviewRounds: 0,
      tokens: tokenUsage({ input: 400_000, output: 12_000, cacheRead: 0, cacheWrite: 0 }),
      costUsd: 1.844,
      durationMs: 125_000,
      retries: 0,
    });

    expect(formatSummary(summary)).toBe('1 slice · 0 review rounds · 412k tokens · $1.84 · 2m 5s');
  });

  it('counts retries once a run has had one', () => {
    const retries = faker.number.int({ min: 2, max: 9 });

    expect(formatSummary(aMetricsSummary({ retries }))).toMatch(
      new RegExp(` · ${retries} retries$`),
    );
  });
});

describe('progressSummary', () => {
  it('sums up a run that has taken a step', () => {
    const summary = aMetricsSummary({ steps: faker.number.int({ min: 1, max: 30 }) });

    expect(progressSummary(summary)).toBe(formatSummary(summary));
  });

  it('has nothing to say about a run that has taken no step', () => {
    expect(progressSummary(aMetricsSummary({ steps: 0 }))).toBeUndefined();
  });
});
