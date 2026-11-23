import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  AgentOutputInvalid,
  AgentRunFailed,
  CodexLoginNotSaved,
  SandboxCredentialsInvalid,
  SandboxPreparationInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
} from './agent-session.js';

describe('agent session failures', () => {
  it.each([
    ['retries an agent run that failed', AgentRunFailed, 'retry'],
    ['retries malformed agent output', AgentOutputInvalid, 'retry'],
    ['retries a sandbox that did not start', SandboxUnavailable, 'retry'],
    ['aborts on unusable agent credentials', SandboxCredentialsInvalid, 'fatal'],
    ['aborts on a sandbox it cannot prepare', SandboxPreparationInvalid, 'fatal'],
    ['aborts on a Codex login not handed back', CodexLoginNotSaved, 'fatal'],
  ])('%s', (_case, Failure, kind) => {
    const failure = new Failure({ message: faker.lorem.sentence() });

    expect(failure.kind).toBe(kind);
    expect(failure._tag).toBe(Failure.name);
  });

  it('retries a failed setup command and keeps what it printed', () => {
    const output = faker.lorem.paragraph();

    const failure = new SetupCommandFailed({ message: faker.lorem.sentence(), output });

    expect(failure).toMatchObject({ kind: 'retry', _tag: 'SetupCommandFailed', output });
  });
});
