import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aSlice, aVerification } from '../../tests/support/builders.js';
import {
  combinedReviewPrompt,
  commitRejectedFeedback,
  EARLIER_FEEDBACK_LIMIT,
  implementPrompt,
  reviewPrompt,
  verifyFailedFeedback,
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

  it('carries a recorded verification failure into configured implementation feedback', () => {
    const command = `npm run ${faker.lorem.slug()}`;
    const output = faker.lorem.paragraph();
    const feedback = verifyFailedFeedback(command, output);
    const slice = aSlice({ lastFeedback: feedback, feedbackHistory: [feedback] });

    const prompt = implementPrompt(slice, command);

    expect(prompt).toContain(feedback);
    expect(prompt).toContain(output);
  });

  it('presents the repository hook output as retry feedback before asking for the commit message', () => {
    const output = faker.lorem.paragraph();
    const { prompt } = setup({ rounds: [commitRejectedFeedback(output)] });

    expect(prompt).toContain(output);
    expect(prompt.indexOf(output)).toBeLessThan(prompt.lastIndexOf('"commitMessage"'));
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
    const slice = aSlice({ verification: aVerification({ command }) });

    const prompt = reviewPrompt(slice, reviewedRange, []);

    expect(prompt).toContain(
      `\`${command}\` passed in the sandbox for the commits in \`${reviewedRange}\``,
    );
    expect(reviewPrompt(aSlice({ verification: undefined }), reviewedRange, [])).not.toContain(
      command,
    );
  });

  it('replaces absent verification guidance with the recorded result', () => {
    const slice = aSlice({ verification: undefined });
    const reviewedRange = range();
    const command = `npm run ${faker.lorem.slug()}`;
    const withoutResult = reviewPrompt(slice, reviewedRange, []);
    const withResult = reviewPrompt(
      { ...slice, verification: aVerification({ command }) },
      reviewedRange,
      [],
    );
    const absentGuidance = withoutResult.split('\n').filter((line) => !withResult.includes(line));

    expect(absentGuidance.length).toBeGreaterThan(0);
    expect(withoutResult).not.toContain(command);
    expect(withResult).toContain(command);
    for (const line of absentGuidance) expect(withResult).not.toContain(line);
  });

  it('adds nothing about protected files when none were touched', () => {
    const prompt = reviewPrompt(aSlice(), range(), []);

    expect(prompt).not.toContain('- ');
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

    expect(prompt).toContain(request);
    expect(prompt).toContain(plan);
    expect(prompt).toContain(reviewedRange);
  });

  it('tells the reviewer which verification the slice recorded, over the range it reviews', () => {
    const command = `npm run ${faker.lorem.slug()}`;
    const reviewedRange = range();

    const prompt = combinedReviewPrompt({
      slice: aSlice({ verification: aVerification({ command }) }),
      range: reviewedRange,
      protectedChanges: [],
      request: faker.lorem.paragraph(),
      plan: faker.lorem.paragraph(),
    });

    expect(prompt).toContain(command);
    expect(prompt).toContain(reviewedRange);
  });

  it('carries the slice, its description and its protected files beside the request', () => {
    const slice = aSlice();
    const modifiedSpec = `${faker.lorem.slug()}.spec.ts`;

    const prompt = combinedReviewPrompt({
      slice,
      range: range(),
      protectedChanges: [{ path: modifiedSpec, kind: 'modified' }],
      request: faker.lorem.paragraph(),
      plan: faker.lorem.paragraph(),
    });

    expect(prompt).toContain(slice.title);
    expect(prompt).toContain(slice.description);
    expect(prompt).toContain(`${modifiedSpec} (modified)`);
  });

  function range() {
    return `${faker.git.commitSha()}..HEAD`;
  }
});
