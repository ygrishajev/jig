import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aCommit, anImplementation, runId, sliceId } from '../../tests/support/builders.js';
import { SteppingClock } from '../../tests/support/fakes.js';
import type { RunEvent, StepLocation } from '../domain/events.js';
import type { MetricRecord } from '../domain/metrics.js';
import type { TokenUsage } from '../domain/usage.js';
import { MetricsObserver } from './metrics.js';

describe('MetricsObserver', () => {
  it('attributes an agent call to the step it ran in', () => {
    const { observe, records } = setup();
    const id = runId();
    const at: StepLocation = { phase: 'slices', sliceId: sliceId(), sliceStatus: 'pending' };
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

  it.each(['stepFinished', 'stepFailed'] as const)(
    'attributes an agent call after a step ended by %s to no step',
    (ended) => {
      const { observe, records } = setup();
      const id = runId();
      const at: StepLocation = { phase: 'slices', sliceId: sliceId(), sliceStatus: 'pending' };

      observe({ type: 'stepStarted', runId: id, at });
      observe(
        ended === 'stepFinished'
          ? { type: ended, runId: id, at, outcome: anImplementation(), durationMs: 1 }
          : { type: ended, runId: id, at, reason: faker.lorem.sentence(), durationMs: 1 },
      );
      observe({ type: 'agentUsage', runId: id, role: 'planner', tokens: someTokens() });

      expect(records.find((record) => record.kind === 'agentCall')?.location).toBeUndefined();
    },
  );

  it('records a step with its outcome, duration and the size of its commit', () => {
    const { observe, records } = setup();
    const commit = aCommit();
    const durationMs = faker.number.int({ min: 1, max: 60_000 });

    observe({
      type: 'stepFinished',
      runId: runId(),
      at: { phase: 'slices', sliceId: sliceId(), sliceStatus: 'pending' },
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
