import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aFeaturePlan, aSlice } from '../../tests/support/builders.js';
import type { Slice } from '../domain/slice.js';
import { pullRequestPrompt } from './pull-request.js';

describe('pullRequestPrompt', () => {
  it('marks a slice line with the command jig recorded for it', () => {
    const command = `npm run ${faker.word.verb()}`;
    const verified = aSlice({ status: 'approved', verification: { command } });
    const { prompt } = setup({
      slices: [verified, aSlice({ status: 'stuck' })],
    });

    const promptText = prompt();

    expect(promptText).toContain(`[${verified.status}, verify passed: ${command}] ${verified.id}:`);
  });

  it('leaves a slice without a recorded verification unmarked', () => {
    const unverified = aSlice({ status: 'stuck' });
    const { prompt } = setup({
      slices: [
        aSlice({
          status: 'approved',
          verification: { command: `npm run ${faker.word.verb()}` },
        }),
        unverified,
      ],
    });

    expect(prompt()).toContain(`[${unverified.status}] ${unverified.id}:`);
  });

  it('drops the rule that made the describer vouch only for checks it ran itself', () => {
    const { prompt } = setup();

    expect(prompt()).not.toContain('only if you ran it here');
  });

  it('tells the describer to state the recorded verification as fact', () => {
    const { prompt } = setup();

    expect(prompt()).toContain('State that record as fact');
  });

  it('names the configured verify command in the verification rule', () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { prompt } = setup({ verifyCommand });

    expect(prompt()).toContain(`verify command is \`${verifyCommand}\``);
  });

  it('says jig ran no checks when no verify command is configured', () => {
    const { prompt } = setup();

    expect(prompt()).toContain('say jig ran no checks');
  });

  function setup(input: { slices?: Slice[]; verifyCommand?: string } = {}) {
    const prompt = () =>
      pullRequestPrompt({
        template: `## ${faker.word.noun()}\n\n<!-- ${faker.lorem.sentence()} -->`,
        plan: aFeaturePlan(),
        slices: input.slices ?? [],
        verifyCommand: input.verifyCommand,
      });
    return { prompt };
  }
});
