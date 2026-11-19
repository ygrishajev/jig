import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  aFailedVerification,
  aFinalCheckResult,
  aRejectedReview,
  aRunState,
  aSlice,
  failureOutput,
  workObservations,
} from '../../tests/support/builders.js';
import { applyOutcome } from './apply-outcome.js';
import {
  captureOutput,
  DIAGNOSTIC_OUTPUT_TAIL,
  failedFinalVerificationSchema,
  rejectedReviewSchema,
  retainedFinalVerificationFailure,
} from './diagnostics.js';
import type { Outcome } from './outcome.js';
import { runDiagnostics } from './run-diagnostics.js';
import { type RunState, runStateSchema } from './run-state.js';
import { failedVerificationSchema } from './slice.js';

describe('run diagnostics', () => {
  it('keeps a rejected review unresolved through the implementation and verification failures after it', () => {
    const { apply, sliceId, command } = setup();
    const feedback = faker.lorem.sentence();
    const output = failureOutput();

    const state = apply(
      { type: 'changesRequested', feedback },
      { type: 'hookRejected', feedback: faker.lorem.sentence() },
      { type: 'nothingChanged', feedback: faker.lorem.sentence() },
      verificationFailure(command, output),
    );

    const diagnostics = runDiagnostics(state);
    expect(diagnostics.unresolvedReviews).toEqual([{ sliceId, feedback, at: 1 }]);
    expect(diagnostics.lastVerificationFailure).toEqual({
      scope: { kind: 'slice', sliceId },
      command,
      output: { captured: true, tail: output, truncated: false },
      at: 4,
      current: true,
    });
  });

  it('replaces the unresolved review with the latest rejection', () => {
    const { apply, sliceId } = setup();
    const latest = faker.lorem.sentence();

    const state = apply(
      { type: 'changesRequested', feedback: faker.lorem.sentence() },
      { type: 'rulesFixRequested', feedback: latest },
    );

    expect(runDiagnostics(state).unresolvedReviews).toEqual([{ sliceId, feedback: latest, at: 2 }]);
  });

  it('resolves the rejected review on a later approval and leaves the resolved history out', () => {
    const { apply } = setup();

    const state = apply(
      { type: 'changesRequested', feedback: faker.lorem.sentence() },
      { type: 'approved' },
    );

    expect(state.slices[0].feedbackHistory).toHaveLength(1);
    expect(runDiagnostics(state).unresolvedReviews).toEqual([]);
  });

  it('keeps a slice verification failure as history once a later verification passes', () => {
    const { apply, sliceId, command } = setup();
    const output = failureOutput();

    const state = apply(verificationFailure(command, output), {
      type: 'verified',
      command,
      observed: workObservations(),
    });

    expect(runDiagnostics(state).lastVerificationFailure).toMatchObject({
      scope: { kind: 'slice', sliceId },
      output: { captured: true, tail: output },
      current: false,
    });
  });

  it('reports the gaps of a failed final check as outstanding, beside its failed verification', () => {
    const { apply, command } = setup({ approved: true });
    const gaps = [faker.lorem.sentence(), faker.lorem.sentence()];
    const output = failureOutput();

    const state = apply(finalCheck({ command, output, gaps }));

    const diagnostics = runDiagnostics(state);
    expect(diagnostics.outstandingGaps).toEqual(gaps);
    expect(diagnostics.lastVerificationFailure).toEqual({
      scope: { kind: 'finalCheck', round: 1 },
      command,
      output: { captured: true, tail: output, truncated: false },
      at: 1,
      current: true,
    });
  });

  it('identifies a failure during the repair as later than the final check that asked for it', () => {
    const { apply, command } = setup({ approved: true });
    const repairOutput = failureOutput();

    const state = apply(
      finalCheck({ command, output: failureOutput(), gaps: [faker.lorem.sentence()] }),
      verificationFailure(command, repairOutput),
    );

    const repair = state.slices.find((slice) => slice.status === 'pending');
    const diagnostics = runDiagnostics(state);
    expect(diagnostics.lastVerificationFailure).toMatchObject({
      scope: { kind: 'slice', sliceId: repair?.id },
      output: { tail: repairOutput },
      at: 2,
      current: true,
    });
    expect(diagnostics.outstandingGaps).toHaveLength(1);
  });

  it('clears the outstanding gaps on a later successful check and keeps its earlier verification failure as history', () => {
    const { apply, command } = setup({ approved: true });
    const output = failureOutput();

    const state = apply(
      finalCheck({ command, output, gaps: [faker.lorem.sentence()] }),
      finalCheck({ command, gaps: [] }),
    );

    const diagnostics = runDiagnostics(state);
    expect(diagnostics.outstandingGaps).toEqual([]);
    expect(diagnostics.lastVerificationFailure).toEqual({
      scope: { kind: 'finalCheck', round: 1 },
      command,
      output: { captured: true, tail: output, truncated: false },
      at: 1,
      current: false,
    });
  });

  it('records the repaired check failing verification again as the current failure of round 2', () => {
    const { apply, command } = setup({ approved: true });
    const output = failureOutput();

    const state = apply(
      finalCheck({ command, output: failureOutput(), gaps: [] }),
      finalCheck({ command, output, gaps: [] }),
    );

    expect(runDiagnostics(state).lastVerificationFailure).toMatchObject({
      scope: { kind: 'finalCheck', round: 2 },
      output: { tail: output },
      at: 2,
      current: true,
    });
  });

  it('keeps only the tail of long output, with the reference it ends on', () => {
    const reference = failureOutput();
    const output = `${faker.string.alpha(DIAGNOSTIC_OUTPUT_TAIL)}\n${reference}`;

    const captured = captureOutput(output);

    expect(captured).toEqual({
      captured: true,
      tail: output.slice(-DIAGNOSTIC_OUTPUT_TAIL),
      truncated: true,
    });
    expect(captured.captured && captured.tail.endsWith(reference)).toBe(true);
  });

  it('loads back every diagnostic a run saved', () => {
    const { apply, command } = setup();

    const state = apply(
      { type: 'changesRequested', feedback: faker.lorem.sentence() },
      verificationFailure(command, failureOutput()),
    );

    const reloaded = runStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(runDiagnostics(reloaded)).toEqual(runDiagnostics(state));
    expect(reloaded.diagnosticSequence).toBe(2);
  });

  it('represents the output of a final check saved before output was kept as unavailable', () => {
    const command = `npm run ${faker.word.verb()}`;
    const { diagnosticSequence: _unordered, ...legacy } = aRunState({
      phase: 'finalCheck',
      finalCheck: aFinalCheckResult({ verified: false, command, round: 1 }),
    });

    const loaded = runStateSchema.parse(legacy);

    expect(loaded.diagnosticSequence).toBe(0);
    expect(runDiagnostics(loaded).lastVerificationFailure).toEqual({
      scope: { kind: 'finalCheck', round: 1 },
      command,
      output: { captured: false },
      at: 0,
      current: true,
    });
  });

  it('keeps the failed verification of a final check saved before output was kept as history once the repaired check passes', () => {
    const command = `npm run ${faker.word.verb()}`;
    const round = 1;
    const { diagnosticSequence: _unordered, ...legacy } = aRunState({
      phase: 'finalCheck',
      finalCheck: aFinalCheckResult({ verified: false, command, round }),
    });
    const loaded = runStateSchema.parse(legacy);

    const repaired = applyOutcome(loaded, finalCheck({ command, gaps: [] }));
    const reloaded = runStateSchema.parse(JSON.parse(JSON.stringify(repaired)));

    expect(reloaded.failedFinalVerification).toEqual({
      command,
      output: { captured: false },
      round,
      at: 0,
      passedSince: true,
    });
    expect(runDiagnostics(reloaded).lastVerificationFailure).toEqual({
      scope: { kind: 'finalCheck', round },
      command,
      output: { captured: false },
      at: 0,
      current: false,
    });
  });

  it('places every ordered failure after one saved before failures were ordered', () => {
    const legacy = aSlice({ order: 0, failedVerification: aFailedVerification({ at: 0 }) });
    const later = aSlice({
      order: 1,
      failedVerification: aFailedVerification({ at: faker.number.int({ min: 1, max: 9 }) }),
    });

    const state = aRunState({ slices: [later, legacy] });

    expect(runDiagnostics(state).lastVerificationFailure?.scope).toEqual({
      kind: 'slice',
      sliceId: later.id,
    });
  });

  it('reports a review left on a stuck slice as unresolved', () => {
    const rejectedReview = aRejectedReview();
    const stuck = aSlice({ status: 'stuck', rejectedReview });

    const state = aRunState({ slices: [stuck] });

    expect(runDiagnostics(state).unresolvedReviews).toEqual([
      { sliceId: stuck.id, ...rejectedReview },
    ]);
  });

  it.each([false, true])(
    'prefers saved history when the latest check verified is %s',
    (verified) => {
      const failed = { ...aFailedVerification(), round: 1, passedSince: true };
      const state = aRunState({
        failedFinalVerification: failed,
        finalCheck: aFinalCheckResult({ verified, round: 2 }),
      });

      expect(retainedFinalVerificationFailure(state)).toBe(state.failedFinalVerification);
    },
  );

  it('finds no retained failure when the final check is missing or verified', () => {
    expect(retainedFinalVerificationFailure({})).toBeUndefined();
    expect(
      retainedFinalVerificationFailure({ finalCheck: aFinalCheckResult({ verified: true }) }),
    ).toBeUndefined();
  });

  it('defaults legacy diagnostic ordering and slice failure capture fields', () => {
    const feedback = faker.lorem.sentence();
    const {
      at: _at,
      output: _output,
      passedSince: _passedSince,
      ...legacy
    } = aFailedVerification();
    const { at: _finalAt, ...finalFailure } = { ...aFailedVerification(), round: 1 };

    expect(rejectedReviewSchema.parse({ feedback })).toEqual({ feedback, at: 0 });
    expect(failedVerificationSchema.parse(legacy)).toEqual({
      ...legacy,
      at: 0,
      output: { captured: false },
      passedSince: false,
    });
    expect(failedFinalVerificationSchema.parse(finalFailure)).toMatchObject({ at: 0 });
  });

  it('marks undefined output unavailable', () => {
    expect(captureOutput(undefined)).toEqual({ captured: false });
  });

  it.each([0, DIAGNOSTIC_OUTPUT_TAIL])(
    'keeps all %i characters without marking output truncated',
    (length) => {
      const output = faker.string.alpha(length);

      expect(captureOutput(output)).toEqual({ captured: true, tail: output, truncated: false });
    },
  );

  function setup({ approved = false }: { approved?: boolean } = {}) {
    const slice = aSlice({ order: 0, status: approved ? 'approved' : 'pending' });
    const start = aRunState({ phase: 'slices', slices: [slice], diagnosticSequence: 0 });
    const apply = (...outcomes: Outcome[]): RunState => outcomes.reduce(applyOutcome, start);
    return { apply, sliceId: slice.id, command: `npm run ${faker.word.verb()}` };
  }
});

function verificationFailure(command: string, output: string): Outcome {
  return {
    type: 'verificationFailed',
    feedback: faker.lorem.sentence(),
    command,
    output,
    observed: workObservations(),
  };
}

function finalCheck({
  command,
  output,
  gaps,
}: {
  command: string;
  output?: string;
  gaps: string[];
}): Outcome {
  return {
    type: 'finalChecked',
    verified: output === undefined,
    command,
    output,
    fulfilled: gaps.length === 0,
    gaps,
  };
}
