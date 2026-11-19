import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aFinalCheckResult, aRunState, aSlice } from '../../tests/support/builders.js';
import {
  FINAL_CHECK_OUTPUT_TAIL,
  type FinalCheckCompletion,
  finalCheckFailed,
  finalCheckNeedsRepair,
  recordFinalCheck,
} from './final-check.js';
import { runStateSchema } from './run-state.js';

describe('recordFinalCheck', () => {
  it('records the completed check of a fulfilled run without adding a repair slice', () => {
    const state = aRunState({ phase: 'finalCheck', slices: [aSlice({ status: 'approved' })] });

    const recorded = recordFinalCheck(state, checkedWith({}));

    expect(recorded.finalCheck).toEqual({
      verified: true,
      command: undefined,
      fulfilled: true,
      gaps: [],
      round: 1,
    });
    expect(recorded.slices).toHaveLength(1);
  });

  it('records no executed command when no verify command is configured', () => {
    const state = aRunState({ phase: 'finalCheck', slices: [aSlice({ status: 'approved' })] });

    const recorded = recordFinalCheck(state, checkedWith({}));

    expect(recorded.finalCheck).toMatchObject({ verified: true, command: undefined });
  });

  it('owes a repair for a failed verification even when the review found nothing missing', () => {
    const failure = faker.lorem.sentence();
    const command = `npm run ${faker.word.verb()}`;
    const state = aRunState({ phase: 'finalCheck', slices: [aSlice({ status: 'approved' })] });

    const recorded = recordFinalCheck(
      state,
      checkedWith({ verified: false, command, output: failure }),
    );

    expect(recorded.finalCheck).toMatchObject({ verified: false, round: 1 });
    expect(recorded.slices).toHaveLength(2);
  });

  it('records round 1 and appends one pending repair slice on the first failure', () => {
    const gap = faker.lorem.sentence();
    const state = aRunState({
      phase: 'finalCheck',
      slices: [aSlice({ order: 4, status: 'approved' })],
    });

    const recorded = recordFinalCheck(state, checkedWith({ fulfilled: false, gaps: [gap] }));

    expect(recorded.slices).toHaveLength(2);
    expect(repairOf(recorded)).toMatchObject({
      id: 'final-fixes',
      title: 'Address the final check findings',
      order: 5,
      status: 'pending',
      reviewCycles: 0,
      emptyAttempts: 0,
      ruleFixCycles: 0,
      feedbackHistory: [],
    });
    expect(repairOf(recorded)?.description).toContain(gap);
  });

  it('appends the repair first when the run has no slices yet', () => {
    const state = aRunState({ phase: 'finalCheck' });

    const recorded = recordFinalCheck(state, checkedWith({ fulfilled: false, gaps: [] }));

    expect(recorded.slices[0]).toMatchObject({ id: 'final-fixes', order: 0 });
  });

  it('appends the repair after every planned slice, whatever order they are saved in', () => {
    const late = aSlice({ order: 9, status: 'approved' });
    const state = aRunState({ phase: 'finalCheck', slices: [late] });

    const recorded = recordFinalCheck(state, checkedWith({ fulfilled: false, gaps: [] }));

    expect(repairOf(recorded)).toMatchObject({ order: 10 });
  });

  it('numbers the repair id past a planned slice that took it', () => {
    const state = aRunState({
      phase: 'finalCheck',
      slices: [aSlice({ id: 'final-fixes', status: 'approved' })],
    });

    const recorded = recordFinalCheck(state, checkedWith({ fulfilled: false, gaps: [] }));

    expect(repairOf(recorded)?.id).toBe('final-fixes-2');
  });

  it('gives the repair a neutral title that fits a commit subject, whatever the check found', () => {
    const state = aRunState({ phase: 'finalCheck', slices: [aSlice({ status: 'approved' })] });
    const fromGaps = recordFinalCheck(state, checkedWith({ fulfilled: false, gaps: ['x'] }));
    const fromVerification = recordFinalCheck(state, checkedWith({ verified: false, output: 'y' }));

    const title = repairOf(fromGaps)?.title ?? '';
    expect(title).toBe(repairOf(fromVerification)?.title);
    expect(title.length).toBeLessThanOrEqual(72);
  });

  it('carries the failed verification into the repair description as its tail, not its head', () => {
    const command = `npm run ${faker.word.verb()}`;
    const head = faker.string.alpha(2000);
    const tail = faker.string.alpha(2000);
    const state = aRunState({ phase: 'finalCheck', slices: [aSlice({ status: 'approved' })] });

    const recorded = recordFinalCheck(
      state,
      checkedWith({ verified: false, command, output: `${head}${tail}` }),
    );

    const description = repairOf(recorded)?.description ?? '';
    expect(description).toContain(`…${`${head}${tail}`.slice(-FINAL_CHECK_OUTPUT_TAIL)}`);
    expect(description).toContain(command);
    expect(description).not.toContain(head.slice(0, 500));
  });

  it('lists both the failed verification and the reviewer gaps in one repair', () => {
    const command = `npm run ${faker.word.verb()}`;
    const failure = faker.lorem.sentence();
    const gap = faker.lorem.sentence();
    const state = aRunState({ phase: 'finalCheck', slices: [aSlice({ status: 'approved' })] });

    const recorded = recordFinalCheck(
      state,
      checkedWith({ verified: false, command, output: failure, fulfilled: false, gaps: [gap] }),
    );

    const description = repairOf(recorded)?.description ?? '';
    expect(description).toContain(failure);
    expect(description).toContain(gap);
  });

  it('names no verification in the repair when only the review found gaps', () => {
    const state = aRunState({ phase: 'finalCheck', slices: [aSlice({ status: 'approved' })] });

    const recorded = recordFinalCheck(state, checkedWith({ fulfilled: false, gaps: ['late'] }));

    const description = repairOf(recorded)?.description ?? '';
    expect(description).toContain('late');
    expect(description).not.toContain('verify command');
  });

  it('adds no second repair and records round 2 when the check completes again after a repair', () => {
    const state = aRunState({ phase: 'slices', slices: [aSlice({ status: 'approved' })] });
    const firstFailure = recordFinalCheck(
      state,
      checkedWith({ fulfilled: false, gaps: [faker.lorem.sentence()] }),
    );
    const repaired = {
      ...firstFailure,
      slices: firstFailure.slices.map((slice) =>
        slice.status === 'pending' ? { ...slice, status: 'approved' as const } : slice,
      ),
    };

    const secondFailure = recordFinalCheck(
      repaired,
      checkedWith({ fulfilled: false, gaps: [faker.lorem.sentence()] }),
    );

    expect(secondFailure.finalCheck).toMatchObject({ round: 2 });
    expect(secondFailure.slices).toEqual(repaired.slices);
  });

  it('stops failing once the repaired run fulfils its request', () => {
    const state = aRunState({ phase: 'slices', slices: [aSlice({ status: 'approved' })] });
    const firstFailure = recordFinalCheck(
      state,
      checkedWith({ fulfilled: false, gaps: [faker.lorem.sentence()] }),
    );

    const repaired = recordFinalCheck(
      firstFailure,
      checkedWith({ command: `npm run ${faker.word.verb()}` }),
    );

    expect(repaired.finalCheck).toMatchObject({ verified: true, round: 2 });
    expect(finalCheckFailed(repaired)).toBe(false);
    expect(repaired.slices).toEqual(firstFailure.slices);
  });

  it('retains a legacy final verification failure as passed after a successful check', () => {
    const command = `npm run ${faker.word.verb()}`;
    const finalCheck = aFinalCheckResult({ verified: false, command });
    const state = aRunState({ finalCheck });

    const recorded = recordFinalCheck(state, checkedWith({ verified: true }));

    expect(recorded.failedFinalVerification).toEqual({
      command,
      output: { captured: false },
      round: finalCheck.round,
      at: 0,
      passedSince: true,
    });
  });

  it('loads a run saved with a recorded final check back as it was saved', () => {
    const state = aRunState({ phase: 'finalCheck', slices: [aSlice({ status: 'approved' })] });
    const recorded = recordFinalCheck(
      state,
      checkedWith({
        verified: false,
        command: `npm run ${faker.word.verb()}`,
        output: faker.lorem.paragraph(),
        fulfilled: false,
        gaps: [faker.lorem.sentence()],
      }),
    );

    expect(runStateSchema.parse(JSON.parse(JSON.stringify(recorded)))).toEqual(recorded);
  });

  it('loads a run saved before anything recorded a final check', () => {
    const state = aRunState({ phase: 'finalCheck', slices: [aSlice({ status: 'approved' })] });
    const { finalCheck: _neverSaved, ...legacy } = recordFinalCheck(state, checkedWith({}));

    expect(runStateSchema.parse(legacy)).toEqual(legacy);
  });
});

describe('finalCheckFailed', () => {
  it('fails the run on a failed verification and on unmet requirements alike', () => {
    const state = aRunState({ phase: 'describing' });
    const verificationFailed = recordFinalCheck(
      state,
      checkedWith({ verified: false, output: 'x' }),
    );
    const requirementsUnmet = recordFinalCheck(
      state,
      checkedWith({ fulfilled: false, gaps: ['y'] }),
    );

    expect(finalCheckFailed(verificationFailed)).toBe(true);
    expect(finalCheckFailed(requirementsUnmet)).toBe(true);
  });

  it('does not fail a run before its final check completed', () => {
    expect(finalCheckFailed(aRunState({ phase: 'finalCheck' }))).toBe(false);
  });
});

describe('finalCheckNeedsRepair', () => {
  it('sends the first failure back through the slices, and not the second', () => {
    const state = aRunState({ phase: 'slices', slices: [aSlice({ status: 'approved' })] });
    const before = aRunState({ phase: 'finalCheck', slices: [aSlice({ status: 'approved' })] });
    const firstFailure = recordFinalCheck(
      state,
      checkedWith({ fulfilled: false, gaps: [faker.lorem.sentence()] }),
    );
    const secondFailure = recordFinalCheck(
      firstFailure,
      checkedWith({ fulfilled: false, gaps: [faker.lorem.sentence()] }),
    );

    expect(finalCheckNeedsRepair(before)).toBe(false);
    expect(finalCheckNeedsRepair(firstFailure)).toBe(true);
    expect(finalCheckNeedsRepair(secondFailure)).toBe(false);
  });
});

function checkedWith(overrides: Partial<FinalCheckCompletion> = {}): FinalCheckCompletion {
  return { type: 'finalChecked', verified: true, fulfilled: true, gaps: [], ...overrides };
}

function repairOf(state: ReturnType<typeof recordFinalCheck>) {
  return state.slices.at(-1);
}
