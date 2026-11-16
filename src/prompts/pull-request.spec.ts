import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  aCompletionEvidence,
  aFeaturePlan,
  aFinalCheckResult,
  aSlice,
} from '../../tests/support/builders.js';
import type { CompletionEvidence } from '../domain/completion-reuse.js';
import type { FinalCheckResult } from '../domain/run-state.js';
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

  it('carries the completed round of the final check into the prompt', () => {
    const { prompt } = setup({ finalCheck: aFinalCheckResult({ round: 2 }) });

    expect(prompt()).toContain(`Round completed: 2`);
  });

  it('states the whole-run verification the final check recorded', () => {
    const command = `npm run ${faker.word.verb()}`;
    const { prompt } = setup({ finalCheck: aFinalCheckResult({ command, verified: false }) });

    expect(prompt()).toContain(`\`${command}\` failed in the sandbox for the run branch.`);
  });

  it('lists the requirements the whole-run review left unmet', () => {
    const gap = faker.lorem.sentence();
    const { prompt } = setup({
      finalCheck: aFinalCheckResult({ fulfilled: false, gaps: [gap], round: 2 }),
    });

    expect(prompt()).toContain('reported the request unfulfilled');
    expect(prompt()).toContain(`1. ${gap}`);
  });

  it('states the verification a reused completion rests on in place of a final check', () => {
    const command = `npm run ${faker.word.verb()}`;
    const { prompt } = setup({
      reusedCompletion: aCompletionEvidence({ verification: { command } }),
    });

    expect(prompt()).toContain(`\`${command}\``);
    expect(prompt()).not.toContain('The whole-run final check did not run.');
  });

  it('says the whole-run check did not run when no result is persisted', () => {
    const { prompt } = setup();

    expect(prompt()).toContain('The whole-run final check did not run.');
  });

  function setup(
    input: {
      slices?: Slice[];
      verifyCommand?: string;
      finalCheck?: FinalCheckResult;
      reusedCompletion?: CompletionEvidence;
    } = {},
  ) {
    const prompt = () =>
      pullRequestPrompt({
        template: `## ${faker.word.noun()}\n\n<!-- ${faker.lorem.sentence()} -->`,
        plan: aFeaturePlan(),
        slices: input.slices ?? [],
        verifyCommand: input.verifyCommand,
        finalCheck: input.finalCheck,
        reusedCompletion: input.reusedCompletion,
      });
    return { prompt };
  }
});
