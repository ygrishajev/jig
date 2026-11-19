import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  aFailedVerification,
  aFinalCheckResult,
  aRejectedReview,
  aRunState,
  aSlice,
} from '../../tests/support/builders.js';
import { runDiagnostics } from './run-diagnostics.js';

describe('runDiagnostics', () => {
  it('selects the later listed slice when failures have equal diagnostic order', () => {
    const at = faker.number.int({ min: 1, max: 50 });
    const first = aSlice({
      order: 9,
      status: 'pending',
      failedVerification: aFailedVerification({ at, passedSince: false }),
    });
    const last = aSlice({
      order: 0,
      status: 'pending',
      failedVerification: aFailedVerification({ at, passedSince: false }),
    });

    const state = aRunState({ slices: [first, last] });
    const diagnostics = runDiagnostics(state);

    expect(diagnostics.lastVerificationFailure).toEqual({
      scope: { kind: 'slice', sliceId: last.id },
      command: last.failedVerification?.command,
      output: last.failedVerification?.output,
      at,
      current: true,
    });
    expect(diagnostics.lastVerificationFailure?.output).toBe(
      state.slices[1].failedVerification?.output,
    );
  });

  it('selects the final failure when it ties with a slice failure', () => {
    const failed = aFailedVerification({ passedSince: false });
    const round = faker.number.int({ min: 1, max: 2 });
    const state = aRunState({
      slices: [aSlice({ failedVerification: aFailedVerification({ at: failed.at }) })],
      failedFinalVerification: { ...failed, round },
    });
    const diagnostics = runDiagnostics(state);

    expect(diagnostics.lastVerificationFailure).toEqual({
      scope: { kind: 'finalCheck', round },
      command: failed.command,
      output: failed.output,
      at: failed.at,
      current: true,
    });
    expect(diagnostics.lastVerificationFailure?.output).toBe(state.failedFinalVerification?.output);
  });

  it('retains unresolved reviews in array order regardless of their diagnostic or slice order', () => {
    const first = aSlice({ order: 9, rejectedReview: aRejectedReview({ at: 8 }) });
    const last = aSlice({ order: 0, rejectedReview: aRejectedReview({ at: 1 }) });

    const diagnostics = runDiagnostics(aRunState({ slices: [first, aSlice(), last] }));

    expect(diagnostics.unresolvedReviews).toEqual([
      { sliceId: first.id, ...first.rejectedReview },
      { sliceId: last.id, ...last.rejectedReview },
    ]);
  });

  it('reports an approved slice retained failure as historical even without a later pass', () => {
    const slice = aSlice({
      status: 'approved',
      failedVerification: aFailedVerification({ passedSince: false }),
    });

    expect(runDiagnostics(aRunState({ slices: [slice] })).lastVerificationFailure?.current).toBe(
      false,
    );
  });

  it('suppresses populated gaps when the final check fulfilled the request', () => {
    const finalCheck = aFinalCheckResult({ fulfilled: true, gaps: [faker.lorem.sentence()] });

    expect(runDiagnostics(aRunState({ finalCheck })).outstandingGaps).toEqual([]);
  });

  it('returns unfulfilled gaps by reference', () => {
    const finalCheck = aFinalCheckResult({ fulfilled: false, gaps: [faker.lorem.sentence()] });

    const state = aRunState({ finalCheck });

    expect(runDiagnostics(state).outstandingGaps).toBe(state.finalCheck?.gaps);
  });

  it('reports no failure or outstanding gaps before either has been recorded', () => {
    expect(runDiagnostics(aRunState())).toEqual({
      unresolvedReviews: [],
      outstandingGaps: [],
      lastVerificationFailure: undefined,
    });
  });
});
