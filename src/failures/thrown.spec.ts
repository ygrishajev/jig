import { faker } from '@faker-js/faker';
import { Panic } from 'better-result';
import { describe, expect, it } from 'vitest';

import { messageOf, rootCause } from './thrown.js';

describe('messageOf', () => {
  it("reads an error's own message", () => {
    const message = faker.lorem.sentence();

    expect(messageOf(new Error(message))).toBe(message);
  });

  it('turns anything else that was thrown into text', () => {
    const thrown = faker.number.int();

    expect(messageOf(thrown)).toBe(String(thrown));
  });
});

describe('rootCause', () => {
  it('finds what was first thrown under nested panics', () => {
    const bug = new Error(faker.lorem.sentence());
    const wrapped = new Panic({
      message: faker.lorem.sentence(),
      cause: new Panic({ message: faker.lorem.sentence(), cause: bug }),
    });

    expect(rootCause(wrapped)).toBe(bug);
  });

  it('keeps a panic that has no cause, and anything that is not a panic', () => {
    const panicWithoutCause = new Panic({ message: faker.lorem.sentence() });
    const bug = new Error(faker.lorem.sentence());

    expect(rootCause(panicWithoutCause)).toBe(panicWithoutCause);
    expect(rootCause(bug)).toBe(bug);
  });
});
