import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aSlice } from '../../tests/support/builders.js';
import { EARLIER_FEEDBACK_LIMIT, implementPrompt, reviewPrompt } from './slice.js';

describe('implementPrompt', () => {
  it('presents the latest feedback to address before the earlier rounds', () => {
    const rounds = [faker.lorem.sentence(), faker.lorem.sentence(), faker.lorem.sentence()];
    const prompt = implementPrompt(aSlice({ lastFeedback: rounds[2], feedbackHistory: rounds }));

    expect(prompt.indexOf('Address this feedback specifically:')).toBeLessThan(
      prompt.indexOf(rounds[2]),
    );
    expect(prompt.indexOf(rounds[2])).toBeLessThan(prompt.indexOf('Round 1:'));
  });

  it('lists the earlier rounds oldest first', () => {
    const oldest = faker.lorem.sentence();
    const middle = faker.lorem.sentence();
    const latest = faker.lorem.sentence();
    const prompt = implementPrompt(
      aSlice({ lastFeedback: latest, feedbackHistory: [oldest, middle, latest] }),
    );

    expect(prompt).toContain(`Round 1:\n${oldest}`);
    expect(prompt).toContain(`Round 2:\n${middle}`);
    expect(prompt.indexOf(`Round 1:\n${oldest}`)).toBeLessThan(
      prompt.indexOf(`Round 2:\n${middle}`),
    );
  });

  it('warns that a problem an earlier round already reported needs a different approach', () => {
    const prompt = implementPrompt(
      aSlice({ lastFeedback: faker.lorem.sentence(), feedbackHistory: twoRounds() }),
    );

    expect(prompt).toContain('did not work: find out why before changing code again');
    expect(prompt).toContain('take a different approach');
  });

  it('cuts an earlier round to its last characters when it exceeds the limit', () => {
    const longRound = faker.string.alphanumeric({ length: EARLIER_FEEDBACK_LIMIT + 500 });
    const latest = faker.lorem.sentence();
    const prompt = implementPrompt(
      aSlice({ lastFeedback: latest, feedbackHistory: [longRound, latest] }),
    );

    expect(prompt).toContain(`…${longRound.slice(-EARLIER_FEEDBACK_LIMIT)}`);
    expect(prompt).not.toContain(longRound.slice(0, 100));
  });

  it('adds nothing about earlier rounds when the slice has only been sent back once', () => {
    const only = faker.lorem.sentence();
    const prompt = implementPrompt(aSlice({ lastFeedback: only, feedbackHistory: [only] }));

    expect(prompt).not.toContain('Round 1:');
    expect(prompt).not.toContain('did not work: find out why');
  });

  function twoRounds() {
    return [faker.lorem.sentence(), faker.lorem.sentence()];
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

  it('adds nothing about protected files when none were touched', () => {
    const prompt = reviewPrompt(aSlice(), range(), []);

    expect(prompt).not.toContain('- ');
  });

  function range() {
    return `${faker.git.commitSha()}..HEAD`;
  }
});
