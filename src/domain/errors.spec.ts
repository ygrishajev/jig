import { faker } from '@faker-js/faker';
import { Panic } from 'better-result';
import { describe, expect, it } from 'vitest';

import {
  AgentOutputInvalid,
  AgentRunFailed,
  CodexLoginNotSaved,
  ConfigInvalid,
  isJigError,
  isTransient,
  type JigError,
  MergeFailed,
  messageOf,
  MetricsLogCorrupt,
  PlanNotCovered,
  RemoteUnavailable,
  rootCause,
  RunInProgress,
  RunRequestInvalid,
  RunStateConflict,
  SandboxUnavailable,
  SetupCommandFailed,
} from './errors.js';

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

describe('isTransient', () => {
  const message = faker.lorem.sentence();

  it('marks a sandbox that did not start as worth another attempt', () => {
    expect(isTransient(new SandboxUnavailable({ message }))).toBe(true);
  });

  it('does not retry a failure that needs a person', () => {
    expect(isTransient(new MergeFailed({ message }))).toBe(false);
    expect(isTransient(new ConfigInvalid({ message }))).toBe(false);
  });
});

describe('isJigError', () => {
  it('recognises jig’s own errors and nothing else', () => {
    const message = faker.lorem.sentence();

    expect(isJigError(new RunInProgress({ message }))).toBe(true);
    expect(isJigError(new Error(message))).toBe(false);
  });
});

describe('SetupCommandFailed', () => {
  it('keeps the setup command output on the error', () => {
    const output = faker.lorem.paragraph();

    expect(new SetupCommandFailed({ message: faker.lorem.sentence(), output }).output).toBe(output);
  });
});

describe('failure kinds', () => {
  const message = () => faker.lorem.sentence();

  it.each<[string, () => JigError, JigError['kind']]>([
    ['an agent run that failed', () => new AgentRunFailed({ message: message() }), 'retry'],
    ['malformed agent output', () => new AgentOutputInvalid({ message: message() }), 'retry'],
    [
      'slices that do not cover the plan',
      () => new PlanNotCovered({ message: message() }),
      'retry',
    ],
    ['an unreachable remote', () => new RemoteUnavailable({ message: message() }), 'retry'],
    ['a sandbox that did not start', () => new SandboxUnavailable({ message: message() }), 'retry'],
    [
      'a failed setup command',
      () => new SetupCommandFailed({ message: message(), output: message() }),
      'retry',
    ],
    ['a conflicting remote run', () => new RunStateConflict({ message: message() }), 'block'],
    ['a failed merge', () => new MergeFailed({ message: message() }), 'block'],
    ['an invalid config', () => new ConfigInvalid({ message: message() }), 'fatal'],
    ['an invalid request', () => new RunRequestInvalid({ message: message() }), 'fatal'],
    ['a run already in progress', () => new RunInProgress({ message: message() }), 'fatal'],
    ['a corrupt metrics log', () => new MetricsLogCorrupt({ message: message() }), 'fatal'],
    ['a Codex login not saved', () => new CodexLoginNotSaved({ message: message() }), 'fatal'],
  ])('treats %s as %s', (_case, create, kind) => {
    const error = create();

    expect(error.kind).toBe(kind);
    expect(error._tag).toBe(error.constructor.name);
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
