import { faker } from '@faker-js/faker';
import { Panic } from 'better-result';
import { describe, expect, it } from 'vitest';

import { exceptionDetails, messageOf, rootCause } from './exception-details.js';

describe('messageOf', () => {
  it("reads an error's own message", () => {
    const message = faker.lorem.sentence();

    expect(messageOf(new Error(message))).toBe(message);
  });

  it.each([
    ['a number', () => faker.number.int()],
    ['a string', () => faker.lorem.sentence()],
    ['undefined', () => undefined],
    ['null', () => null],
  ])('turns %s that was thrown into text', (_case, create) => {
    const thrown = create();

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

  it('keeps a panic that has no cause', () => {
    const panicWithoutCause = new Panic({ message: faker.lorem.sentence() });

    expect(rootCause(panicWithoutCause)).toBe(panicWithoutCause);
  });

  it('stops at the innermost panic whose cause is undefined', () => {
    const innermost = new Panic({ message: faker.lorem.sentence(), cause: undefined });
    const wrapped = new Panic({ message: faker.lorem.sentence(), cause: innermost });

    expect(rootCause(wrapped)).toBe(innermost);
  });

  it('unwraps a panic whose cause is null to the null that was thrown', () => {
    const wrapped = new Panic({ message: faker.lorem.sentence(), cause: null });

    expect(rootCause(wrapped)).toBeNull();
  });

  it('does not follow the cause of an ordinary error', () => {
    const cause = new Panic({ message: faker.lorem.sentence() });
    const bug = new Error(faker.lorem.sentence(), { cause });

    expect(rootCause(bug)).toBe(bug);
  });

  it('stops at an ordinary error under panics without following its own cause', () => {
    const bug = new Error(faker.lorem.sentence(), { cause: new Error(faker.lorem.sentence()) });
    const wrapped = new Panic({ message: faker.lorem.sentence(), cause: bug });

    expect(rootCause(wrapped)).toBe(bug);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('returns %s unchanged', (_case, thrown) => {
    expect(rootCause(thrown)).toBe(thrown);
  });
});

describe('exceptionDetails', () => {
  it('supplies the message reader and the panic unwrapper as one capability', () => {
    expect(exceptionDetails).toEqual({ messageOf, rootCause });
  });
});
