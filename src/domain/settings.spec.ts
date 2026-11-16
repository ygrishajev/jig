import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aSlice, runSettings } from '../../tests/support/builders.js';
import { sliceNeedsVerification, sliceStopReason } from './settings.js';

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
