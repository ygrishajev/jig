import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../domain/events.js';
import type { TokenUsage } from '../domain/usage.js';
import { aCommit, anImplementation, runId, sliceId } from '../../tests/support/builders.js';
import { SteppingClock } from '../../tests/support/fakes.js';
import { formatSummary, MetricsObserver, summarizeMetrics, type MetricRecord } from './metrics.js';

describe('MetricsObserver', () => {
  it('attributes an agent call to the step it ran in', () => {
    const { observe, records } = setup();
    const id = runId();
    const at = { phase: 'slices' as const, sliceId: sliceId(), sliceStatus: 'pending' };
    const tokens = someTokens();

    observe({ type: 'stepStarted', runId: id, at });
    observe({ type: 'agentUsage', runId: id, role: 'implementer', costUsd: 0.5, tokens });

    expect(records[0]).toMatchObject({
      kind: 'agentCall',
      role: 'implementer',
      location: at,
      tokens,
    });
  });

  it('records a step with its outcome, duration and the size of its commit', () => {
    const { observe, records } = setup();
    const commit = aCommit();
    const durationMs = faker.number.int({ min: 1, max: 60_000 });

    observe({
      type: 'stepFinished',
      runId: runId(),
      at: { phase: 'slices', sliceId: sliceId() },
      outcome: anImplementation({ commit }),
      durationMs,
    });

    expect(records[0]).toMatchObject({ kind: 'step', outcome: 'implemented', durationMs, commit });
  });

  function setup() {
    const records: MetricRecord[] = [];
    const observer = new MetricsObserver((record) => records.push(record), new SteppingClock());
    return { observe: (event: RunEvent) => observer.handle(event), records };
  }
});

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

  it('reads as one line', () => {
    const summary = summarizeMetrics([
      step({ sliceId: sliceId(), outcome: 'implemented', durationMs: 125_000, commit: aCommit() }),
      call({
        costUsd: 1.844,
        tokens: { input: 400_000, output: 12_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      }),
    ]);

    expect(formatSummary(summary)).toBe('1 slice · 0 review rounds · 412k tokens · $1.84 · 2m 5s');
  });
});

function step(input: {
  sliceId: string;
  outcome: 'implemented' | 'changesRequested';
  durationMs: number;
  commit?: ReturnType<typeof aCommit>;
}): MetricRecord {
  return {
    kind: 'step',
    at: now(),
    runId: runId(),
    location: { phase: 'slices', sliceId: input.sliceId },
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
