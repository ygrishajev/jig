import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aSlice, runSettings } from '../../tests/support/builders.js';
import { sliceNeedsVerification } from './settings.js';

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
