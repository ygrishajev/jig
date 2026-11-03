import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { ConfigInvalid, orThrow } from '../../domain/errors.js';
import { AGENTS, collectCredentials } from './agents.js';

describe('collectCredentials', () => {
  it('passes the explicit Codex auth directory without forwarding unrelated credentials', () => {
    const directory = faker.system.directoryPath();
    const credentials = collectCredentials(
      [{ provider: 'codex', model: faker.word.noun() }],
      lookup({ JIG_CODEX_AUTH_DIR: directory, OPENAI_API_KEY: faker.string.alphanumeric(40) }),
    );
    expect(orThrow(credentials)).toEqual({ JIG_CODEX_AUTH_DIR: directory });
  });

  it('requires an explicit model for Codex', () => {
    const created = AGENTS.codex.create();

    expect(created.isErr() && created.error).toBeInstanceOf(ConfigInvalid);
  });

  it('passes on whichever claude credential is set', () => {
    const token = faker.string.alphanumeric(40);

    const credentials = collectCredentials(
      [{ provider: 'claude' }],
      lookup({ CLAUDE_CODE_OAUTH_TOKEN: token }),
    );

    expect(orThrow(credentials)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: token });
  });

  it("derives opencode's credential from the provider in its model", () => {
    const key = faker.string.alphanumeric(40);

    const credentials = collectCredentials(
      [{ provider: 'opencode', model: `openrouter/${faker.word.noun()}` }],
      lookup({ OPENROUTER_API_KEY: key, UNRELATED_SECRET: faker.string.alphanumeric(20) }),
    );

    expect(orThrow(credentials)).toEqual({ OPENROUTER_API_KEY: key });
  });

  it('gathers what every configured step needs, and nothing else from the environment', () => {
    const token = faker.string.alphanumeric(40);
    const key = faker.string.alphanumeric(40);

    const credentials = collectCredentials(
      [{ provider: 'claude' }, { provider: 'opencode', model: `openrouter/${faker.word.noun()}` }],
      lookup({
        CLAUDE_CODE_OAUTH_TOKEN: token,
        OPENROUTER_API_KEY: key,
        HOME: faker.system.directoryPath(),
      }),
    );

    expect(orThrow(credentials)).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: token,
      OPENROUTER_API_KEY: key,
    });
  });

  it('names the variables to set when an agent has no credential', () => {
    const collected = collectCredentials([{ provider: 'claude' }], lookup({}));

    expect(collected.isErr() && collected.error).toBeInstanceOf(ConfigInvalid);
    for (const key of orThrow(AGENTS.claude.credentialKeys())) {
      expect(collected.isErr() && collected.error.message).toContain(key);
    }
  });

  it('asks for a model before it can tell which credential opencode needs', () => {
    const collected = collectCredentials([{ provider: 'opencode' }], lookup({}));

    expect(collected.isErr() && collected.error).toBeInstanceOf(ConfigInvalid);
  });
});

describe('AGENTS', () => {
  it("leaves every agent's transcripts in the sandbox instead of copying them to the host", () => {
    const model = `openrouter/${faker.word.noun()}`;

    for (const agent of Object.values(AGENTS)) {
      expect(orThrow(agent.create(model)).captureSessions).toBe(false);
    }
  });
});

function lookup(variables: Record<string, string>) {
  return (name: string): string | undefined => variables[name];
}
