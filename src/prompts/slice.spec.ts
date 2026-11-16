import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aSlice } from '../../tests/support/builders.js';
import { EARLIER_FEEDBACK_LIMIT, implementPrompt, reviewPrompt } from './slice.js';

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

  function range() {
    return `${faker.git.commitSha()}..HEAD`;
  }
});
