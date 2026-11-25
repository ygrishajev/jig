import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aCommit, runId, sliceId } from '../../tests/support/builders.js';
import { type MetricRecord, summarizeMetrics, totalTokens } from './metrics.js';
import type { TokenUsage } from './usage.js';

describe('summarizeMetrics', () => {
  it('totals cost, tokens, duration, review rounds and committed slices', () => {
    const first = sliceId();
    const second = sliceId();
    const firstCommit = aCommit();
    const secondCommit = aCommit();
    const tokens = [someTokens(), someTokens()];
    const records: MetricRecord[] = [
      step({ sliceId: first, outcome: 'implemented', durationMs: 1000, commit: firstCommit }),
      step({ sliceId: first, outcome: 'changesRequested', durationMs: 2000 }),
      step({
        sliceId: first,
        outcome: 'implemented',
        durationMs: 3000,
        commit: aCommit({ ...firstCommit }),
      }),
      step({ sliceId: second, outcome: 'implemented', durationMs: 4000, commit: secondCommit }),
      call({ costUsd: 0.25, tokens: tokens[0] }),
      call({ costUsd: undefined, tokens: tokens[1] }),
      {
        kind: 'retry',
        at: now(),
        runId: runId(),
        location: { phase: 'context' },
        reason: faker.lorem.sentence(),
      },
    ];

    const summary = summarizeMetrics(records);

    expect(summary).toMatchObject({
      durationMs: 10_000,
      steps: 4,
      agentCalls: 2,
      retries: 1,
      reviewRounds: 1,
      slicesCommitted: 2,
      costUsd: 0.25,
    });
    expect(summary.tokens.input).toBe(tokens[0].input + tokens[1].input);
  });

  it('counts a rules-only rejection as a review round', () => {
    const summary = summarizeMetrics([
      step({ sliceId: sliceId(), outcome: 'rulesFixRequested', durationMs: 1000 }),
      step({ sliceId: sliceId(), outcome: 'changesRequested', durationMs: 1000 }),
    ]);

    expect(summary.reviewRounds).toBe(2);
  });
});

describe('totalTokens', () => {
  it('adds input, output and cache tokens, leaving reasoning out', () => {
    const tokens = { input: 1000, output: 200, cacheRead: 30, cacheWrite: 4, reasoning: 500 };

    expect(totalTokens(tokens)).toBe(1234);
  });
});

function step(input: {
  sliceId: string;
  outcome: 'implemented' | 'changesRequested' | 'rulesFixRequested';
  durationMs: number;
  commit?: ReturnType<typeof aCommit>;
}): MetricRecord {
  return {
    kind: 'step',
    at: now(),
    runId: runId(),
    location: { phase: 'slices', sliceId: input.sliceId, sliceStatus: 'pending' },
    outcome: input.outcome,
    durationMs: input.durationMs,
    ...(input.commit ? { commit: input.commit } : {}),
  };
}

function call(input: { costUsd?: number; tokens: TokenUsage }): MetricRecord {
  return { kind: 'agentCall', at: now(), runId: runId(), role: 'implementer', ...input };
}

function someTokens(): TokenUsage {
  const count = () => faker.number.int({ min: 0, max: 10_000 });
  return {
    input: count(),
    output: count(),
    cacheRead: count(),
    cacheWrite: count(),
    reasoning: count(),
  };
}

function now() {
  return new Date().toISOString();
}
