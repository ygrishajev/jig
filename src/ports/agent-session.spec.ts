import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { AgentOutputInvalid, AgentRunFailed } from './agent-session.js';

describe('agent-session failures', () => {
  it('classifies AgentRunFailed and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new AgentRunFailed({ message });

    expect(error).toMatchObject({
      _tag: 'AgentRunFailed',
      kind: 'retry',
      message,
    });
  });

  it('classifies AgentOutputInvalid and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new AgentOutputInvalid({ message });

    expect(error).toMatchObject({
      _tag: 'AgentOutputInvalid',
      kind: 'retry',
      message,
    });
  });
});
