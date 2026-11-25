import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  aDesignFinding,
  aMetricsSummary,
  aRunBlockedByDesignReview,
  aRunState,
  aSlice,
} from '../../tests/support/builders.js';
import type { InvocationStatus } from '../domain/invocation-status.js';
import { runStopReason } from '../domain/run-state.js';
import { invocationRecord } from './invocation-record.js';
import { runDocumentContents } from './run-documents.js';

describe('invocationRecord', () => {
  it('records how a stuck run ended for CI, naming the stuck slice, beside its documents', () => {
    const state = aRunState({ phase: 'stuck', slices: [aSlice({ status: 'stuck' })] });
    const metrics = aMetricsSummary();

    const record = invocationRecord(state, 'stuck', metrics);

    expect(record).toEqual({
      runId: state.runId,
      result: {
        status: 'stuck',
        phase: 'stuck',
        complete: false,
        blockedReason: runStopReason(state),
        metrics,
      },
      documents: runDocumentContents(state, metrics),
    });
  });

  it.each([
    'hookFailures',
    'verificationFailures',
    'emptyAttempts',
    'ruleFixCycles',
    'reviewCycles',
  ] as const)('gives the exhausted %s budget as the terminal reason', (counter) => {
    const state = aRunState({
      phase: 'stuck',
      slices: [aSlice({ status: 'stuck', [counter]: 3 })],
    });

    const { result } = invocationRecord(state, 'stuck', aMetricsSummary());

    expect(result.blockedReason).toBe(runStopReason(state));
  });

  it('tells CI which design findings block the run', () => {
    const outstanding = [aDesignFinding(), aDesignFinding()];
    const state = aRunBlockedByDesignReview({ outstanding });

    const { result } = invocationRecord(state, 'blocked', aMetricsSummary());

    expect(result).toMatchObject({
      status: 'blocked',
      phase: 'resolvingDesign',
      blockedReason: state.blockedReason,
    });
    for (const finding of outstanding) expect(result.blockedReason).toContain(finding.id);
  });

  it.each<{ status: InvocationStatus; complete: boolean }>([
    { status: 'done', complete: true },
    { status: 'completed', complete: true },
    { status: 'stuck', complete: false },
    { status: 'halted', complete: false },
    { status: 'blocked', complete: false },
  ])(
    'counts $status as complete=$complete, with no reason when nothing stopped it',
    ({ status, complete }) => {
      const state = aRunState({ phase: 'context' });

      const { result } = invocationRecord(state, status, aMetricsSummary());

      expect(result.complete).toBe(complete);
      expect(result.blockedReason).toBeUndefined();
    },
  );

  it.each([faker.lorem.sentence(), ''])(
    'prefers the saved blocked reason %j over the terminal reason',
    (blockedReason) => {
      const state = aRunState({
        phase: 'stuck',
        slices: [aSlice({ status: 'stuck' })],
        blockedReason,
      });

      const { result } = invocationRecord(state, 'blocked', aMetricsSummary());

      expect(result.blockedReason).toBe(blockedReason);
    },
  );
});
