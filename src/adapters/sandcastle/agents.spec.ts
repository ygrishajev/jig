import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { ConfigInvalid } from '../../domain/errors.js';
import { AGENTS, collectCredentials } from './agents.js';

describe('collectCredentials', () => {
  it('passes on whichever claude credential is set', () => {
    const token = faker.string.alphanumeric(40);

    const credentials = collectCredentials([{ provider: 'claude' }], {
      CLAUDE_CODE_OAUTH_TOKEN: token,
    });

    expect(credentials).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: token });
  });

  it("derives opencode's credential from the provider in its model", () => {
    const key = faker.string.alphanumeric(40);

    const credentials = collectCredentials(
      [{ provider: 'opencode', model: `openrouter/${faker.word.noun()}` }],
      { OPENROUTER_API_KEY: key, UNRELATED_SECRET: faker.string.alphanumeric(20) },
    );

    expect(credentials).toEqual({ OPENROUTER_API_KEY: key });
  });

  it('gathers what every configured step needs, and nothing else from the environment', () => {
    const token = faker.string.alphanumeric(40);
    const key = faker.string.alphanumeric(40);

    const credentials = collectCredentials(
      [{ provider: 'claude' }, { provider: 'opencode', model: `openrouter/${faker.word.noun()}` }],
      {
        CLAUDE_CODE_OAUTH_TOKEN: token,
        OPENROUTER_API_KEY: key,
        HOME: faker.system.directoryPath(),
      },
    );

    expect(credentials).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: token, OPENROUTER_API_KEY: key });
  });

  it('names the variables to set when an agent has no credential', () => {
    const collecting = () => collectCredentials([{ provider: 'claude' }], {});

    expect(collecting).toThrow(ConfigInvalid);
    for (const key of AGENTS.claude.credentialKeys()) expect(collecting).toThrow(key);
  });

  it('asks for a model before it can tell which credential opencode needs', () => {
    expect(() => collectCredentials([{ provider: 'opencode' }], {})).toThrow(ConfigInvalid);
  });
});
