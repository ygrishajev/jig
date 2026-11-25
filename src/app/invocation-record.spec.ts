import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  aDesignFinding,
  aMetricsSummary,
  aRunBlockedByDesignReview,
  aRunState,
  aSlice,
} from '../../tests/support/builders.js';
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

  it('counts a finished run as complete, with no reason when nothing stopped it', () => {
    const { result } = invocationRecord(aRunState({ phase: 'done' }), 'done', aMetricsSummary());

    expect(result).toMatchObject({ complete: true, blockedReason: undefined });
  });

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
