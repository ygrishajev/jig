import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import {
  AgentOutputInvalid,
  AgentRunFailed,
  ConfigInvalid,
  MergeFailed,
  messageOf,
  MetricsLogCorrupt,
  RemoteUnavailable,
  RunInProgress,
  RunRequestInvalid,
  RunStateConflict,
  SandboxUnavailable,
  SetupCommandFailed,
  type SdlcError,
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

describe('failure kinds', () => {
  const message = () => faker.lorem.sentence();

  it.each<[string, () => SdlcError, SdlcError['kind']]>([
    ['an agent run that failed', () => new AgentRunFailed(message()), 'retry'],
    ['malformed agent output', () => new AgentOutputInvalid(message()), 'retry'],
    ['an unreachable remote', () => new RemoteUnavailable(message()), 'retry'],
    ['a sandbox that did not start', () => new SandboxUnavailable(message()), 'retry'],
    ['a failed setup command', () => new SetupCommandFailed(message(), message()), 'retry'],
    ['a conflicting remote run', () => new RunStateConflict(message()), 'block'],
    ['a failed merge', () => new MergeFailed(message()), 'block'],
    ['an invalid config', () => new ConfigInvalid(message()), 'fatal'],
    ['an invalid request', () => new RunRequestInvalid(message()), 'fatal'],
    ['a run already in progress', () => new RunInProgress(message()), 'fatal'],
    ['a corrupt metrics log', () => new MetricsLogCorrupt(message()), 'fatal'],
  ])('treats %s as %s', (_case, create, kind) => {
    const error = create();

    expect(error.kind).toBe(kind);
    expect(error.name).toBe(error.constructor.name);
  });
});
