import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aSlice } from '../../tests/support/builders.js';
import {
  combinedReviewPrompt,
  EARLIER_FEEDBACK_LIMIT,
  implementPrompt,
  reviewPrompt,
} from './slice.js';

describe('implementPrompt', () => {
  it('presents the latest feedback to address before the earlier rounds', () => {
    const rounds = [faker.lorem.sentence(), faker.lorem.sentence(), faker.lorem.sentence()];
    const { prompt } = setup({ rounds });

    expect(prompt.indexOf('Address this feedback specifically:')).toBeLessThan(
      prompt.indexOf(rounds[2]),
    );
    expect(prompt.indexOf(rounds[2])).toBeLessThan(prompt.indexOf('Round 1:'));
  });

  it('lists the earlier rounds oldest first', () => {
    const rounds = [faker.lorem.sentence(), faker.lorem.sentence(), faker.lorem.sentence()];
    const { prompt } = setup({ rounds });

    expect(prompt).toContain(`Round 1:\n${rounds[0]}`);
    expect(prompt).toContain(`Round 2:\n${rounds[1]}`);
    expect(prompt.indexOf(`Round 1:\n${rounds[0]}`)).toBeLessThan(
      prompt.indexOf(`Round 2:\n${rounds[1]}`),
    );
  });

  it('warns that a problem an earlier round already reported needs a different approach', () => {
    const { prompt } = setup({ rounds: [faker.lorem.sentence(), faker.lorem.sentence()] });

    expect(prompt).toContain('did not work: find out why before changing code again');
    expect(prompt).toContain('take a different approach');
  });

  it('cuts an earlier round to its last characters when it exceeds the limit', () => {
    const longRound = faker.string.alphanumeric({ length: EARLIER_FEEDBACK_LIMIT + 500 });
    const latest = faker.lorem.sentence();
    const { prompt } = setup({ rounds: [longRound, latest] });

    expect(prompt).toContain(`…${longRound.slice(-EARLIER_FEEDBACK_LIMIT)}`);
    expect(prompt).not.toContain(longRound.slice(0, 100));
  });

  it('adds nothing about earlier rounds when the slice has only been sent back once', () => {
    const { prompt } = setup({ rounds: [faker.lorem.sentence()] });

    expect(prompt).not.toContain('Round 1:');
    expect(prompt).not.toContain('did not work: find out why');
  });

  it('passes the configured verify command to the implementer as jig-owned verification', () => {
    const verifyCommand = `npm run ${faker.lorem.slug()}`;

    const prompt = implementPrompt(aSlice(), verifyCommand);

    expect(prompt).toContain(verifyCommand);
  });

  it('ends with the verify command so the implementer reads it last', () => {
    const verifyCommand = `npm run ${faker.lorem.slug()}`;

    const prompt = implementPrompt(aSlice(), verifyCommand);

    expect(prompt.lastIndexOf(verifyCommand)).toBeGreaterThan(prompt.indexOf('commitMessage'));
  });

  it('replaces fallback guidance when a verify command is supplied', () => {
    const command = `npm run ${faker.lorem.slug()}`;
    const slice = aSlice();
    const withoutCommand = implementPrompt(slice);
    const fallback = withoutCommand.slice(withoutCommand.lastIndexOf('\n\n') + 2).trim();
    const withCommand = implementPrompt(slice, command);

    expect(fallback).not.toBe('');
    expect(withCommand).not.toContain(fallback);
    expect(withCommand).toContain(command);
  });

  function setup(input: { rounds: string[] }) {
    const slice = aSlice({
      lastFeedback: input.rounds[input.rounds.length - 1],
      feedbackHistory: input.rounds,
    });
    return { slice, prompt: implementPrompt(slice) };
  }
});

describe('reviewPrompt', () => {
  it('lists the protected files the commits touch, with how each changed', () => {
    const modifiedSpec = `${faker.lorem.slug()}.spec.ts`;
    const deletedWorkflow = `.github/workflows/${faker.lorem.slug()}.yml`;

    const prompt = reviewPrompt(aSlice(), range(), [
      { path: modifiedSpec, kind: 'modified' },
      { path: deletedWorkflow, kind: 'deleted' },
    ]);

    expect(prompt).toContain(`${modifiedSpec} (modified)`);
    expect(prompt).toContain(`${deletedWorkflow} (deleted)`);
  });

  it('reports the recorded verification for the reviewed range', () => {
    const command = `npm run ${faker.lorem.slug()}`;
    const reviewedRange = range();
    const slice = aSlice({ verification: { command } });

    const prompt = reviewPrompt(slice, reviewedRange, []);

    expect(prompt).toContain(
      `\`${command}\` passed in the sandbox for the commits in \`${reviewedRange}\``,
    );
    expect(reviewPrompt(aSlice({ verification: undefined }), reviewedRange, [])).not.toContain(
      command,
    );
  });

  it('adds nothing about protected files when none were touched', () => {
    const prompt = reviewPrompt(aSlice(), range(), []);

    expect(prompt).not.toContain('- ');
  });

  it('never shows the request or the plan', () => {
    const request = `# ${faker.lorem.sentence()}`;

    const prompt = reviewPrompt(aSlice(), range(), []);

    expect(prompt).not.toContain(request);
    expect(prompt).not.toContain('--- REQUEST START ---');
    expect(prompt).not.toContain('--- PLAN START ---');
  });

  function range() {
    return `${faker.git.commitSha()}..HEAD`;
  }
});

describe('combinedReviewPrompt', () => {
  it('gives the reviewer the original request and the plan beside the slice it reviews', () => {
    const request = `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`;
    const plan = `# Plan\n\n## Step 1 — ${faker.lorem.sentence()}\n`;
    const reviewedRange = range();

    const prompt = combinedReviewPrompt({
      slice: aSlice(),
      range: reviewedRange,
      protectedChanges: [],
      request,
      plan,
    });

    expect(prompt).toContain(`--- REQUEST START ---\n${request}\n--- REQUEST END ---`);
    expect(prompt).toContain(`--- PLAN START ---\n${plan}\n--- PLAN END ---`);
    expect(prompt).toContain(reviewedRange);
  });

  it('reports the recorded verification for the whole run range it reviews', () => {
    const command = `npm run ${faker.lorem.slug()}`;
    const reviewedRange = range();

    const recorded = combinedReviewPrompt({
      slice: aSlice({ verification: { command } }),
      range: reviewedRange,
      protectedChanges: [],
      request: faker.lorem.paragraph(),
      plan: faker.lorem.paragraph(),
    });
    const absent = combinedReviewPrompt({
      slice: aSlice({ verification: undefined }),
      range: reviewedRange,
      protectedChanges: [],
      request: faker.lorem.paragraph(),
      plan: faker.lorem.paragraph(),
    });

    expect(recorded).toContain(
      `\`${command}\` passed in the sandbox for the commits in \`${reviewedRange}\``,
    );
    expect(absent).toContain(
      "no verify result is recorded (no verify command is configured) — run the project's tests and lint yourself before approving",
    );
  });

  it('asks for the request verdict in the same reply as the code verdict, decided independently', () => {
    const prompt = combinedReviewPrompt({
      slice: aSlice(),
      range: range(),
      protectedChanges: [],
      request: faker.lorem.paragraph(),
      plan: faker.lorem.paragraph(),
    });

    expect(prompt).toContain('"fulfilled": boolean, "gaps": string[]');
    expect(prompt).toContain('Set fulfilled to true only when the whole run fulfils the request');
    expect(prompt).toContain('Decide the two verdicts independently');
  });

  it('keeps every duty of the ordinary slice review', () => {
    const prompt = combinedReviewPrompt({
      slice: aSlice(),
      range: range(),
      protectedChanges: [{ path: `${faker.lorem.slug()}.spec.ts`, kind: 'modified' }],
      request: faker.lorem.paragraph(),
      plan: faker.lorem.paragraph(),
    });

    expect(prompt).toContain('pure scaffolding (types, builders, refactors) for later slices');
    expect(prompt).toContain('onlyRuleFindings');
  });

  function range() {
    return `${faker.git.commitSha()}..HEAD`;
  }
});
