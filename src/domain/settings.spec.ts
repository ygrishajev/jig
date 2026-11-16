import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aSlice, runSettings } from '../../tests/support/builders.js';
import {
  hookFailureCapReached,
  reviewCapReached,
  sliceNeedsVerification,
  sliceStopReason,
  verificationFailureCapReached,
} from './settings.js';

describe('sliceNeedsVerification', () => {
  it('does not hold a slice back when no verify command is configured', () => {
    const slice = aSlice({ verification: undefined });

    expect(sliceNeedsVerification(slice, runSettings({ verifyCommand: undefined }))).toBe(false);
    expect(sliceNeedsVerification(slice, runSettings({ verifyCommand: '' }))).toBe(false);
  });

  it('does not hold a slice back that already has a verification record', () => {
    const command = `npm run ${faker.word.verb()}`;
    const { slice, settings } = setup({ verifyCommand: command, verification: { command } });

    expect(sliceNeedsVerification(slice, settings)).toBe(false);
  });

  it('holds a slice back until it has a verification record', () => {
    const { slice, settings } = setup({ verification: undefined });

    expect(sliceNeedsVerification(slice, settings)).toBe(true);
  });

  function setup(input: { verifyCommand?: string; verification?: { command: string } }) {
    const slice = aSlice({ verification: input.verification });
    const settings = runSettings({
      verifyCommand: input.verifyCommand ?? `npm run ${faker.word.verb()}`,
    });
    return { slice, settings };
  }
});

describe('sliceStopReason', () => {
  it.each([
    ['hookFailures', 'commit hooks failed'],
    ['verificationFailures', 'verification failed'],
    ['emptyAttempts', 'implementation changed nothing'],
    ['ruleFixCycles', 'house-rule fixes reached the cap'],
    ['reviewCycles', 'review rejections reached the review cap'],
  ] as const)('identifies an exhausted %s budget with its failure count', (counter, reason) => {
    const failures = faker.number.int({ min: 3, max: 10 });
    const slice = aSlice({ [counter]: failures });

    const reported = sliceStopReason(slice);

    expect(reported).toContain(reason);
    expect(reported).toContain(String(failures));
  });
});

describe('independent failure caps', () => {
  it.each([
    [0, false, false],
    [1, false, false],
    [2, false, true],
    [3, true, true],
    [4, true, true],
  ] as const)('enforces each independent cap at %i failures', (failures, failureCap, reviewCap) => {
    const slice = aSlice({
      hookFailures: failures,
      verificationFailures: failures,
      reviewCycles: failures,
    });
    const settings = runSettings({ reviewCycleCap: 2 });

    expect(hookFailureCapReached(slice)).toBe(failureCap);
    expect(verificationFailureCapReached(slice)).toBe(failureCap);
    expect(reviewCapReached(slice, settings)).toBe(reviewCap);
  });

  it.each(['hookFailures', 'verificationFailures', 'reviewCycles'] as const)(
    'does not spend other budgets when %s is exhausted',
    (counter) => {
      const slice = aSlice({
        hookFailures: 0,
        verificationFailures: 0,
        reviewCycles: 0,
        [counter]: 3,
      });

      expect(hookFailureCapReached(slice)).toBe(counter === 'hookFailures');
      expect(verificationFailureCapReached(slice)).toBe(counter === 'verificationFailures');
      expect(reviewCapReached(slice, runSettings({ reviewCycleCap: 3 }))).toBe(
        counter === 'reviewCycles',
      );
    },
  );
});
