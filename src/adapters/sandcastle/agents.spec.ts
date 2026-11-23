import { faker } from '@faker-js/faker';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { codexLogin } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { ConfigInvalid } from '../../config/errors.js';
import { CredentialsInvalid } from '../../ports/credentials.js';
import { AGENTS, collectCredentials } from './agents.js';

describe('collectCredentials', () => {
  it('passes the explicit Codex auth directory without forwarding unrelated credentials', async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, 'auth.json'), codexLogin());
    const credentials = collectCredentials(
      [{ provider: 'codex', model: faker.word.noun() }],
      lookup({ JIG_CODEX_AUTH_DIR: directory, OPENAI_API_KEY: faker.string.alphanumeric(40) }),
    );
    expect(unwrap(credentials)).toEqual({ JIG_CODEX_AUTH_DIR: directory });
  });

  it('fails on a Codex login that is not there, naming the variable to fix', async () => {
    const directory = await tempDirectory();

    const credentials = collectCredentials(
      [{ provider: 'codex', model: faker.word.noun() }],
      lookup({ JIG_CODEX_AUTH_DIR: directory }),
    );

    expect(credentials.isErr() && credentials.error).toBeInstanceOf(CredentialsInvalid);
    expect(credentials.isErr() && credentials.error.message).toContain('JIG_CODEX_AUTH_DIR');
    expect(credentials.isErr() && credentials.error.message).toContain(directory);
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

    expect(unwrap(credentials)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: token });
  });

  it("derives opencode's credential from the provider in its model", () => {
    const key = faker.string.alphanumeric(40);

    const credentials = collectCredentials(
      [{ provider: 'opencode', model: `openrouter/${faker.word.noun()}` }],
      lookup({ OPENROUTER_API_KEY: key, UNRELATED_SECRET: faker.string.alphanumeric(20) }),
    );

    expect(unwrap(credentials)).toEqual({ OPENROUTER_API_KEY: key });
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

    expect(unwrap(credentials)).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: token,
      OPENROUTER_API_KEY: key,
    });
  });

  it('names the variables to set when an agent has no credential', () => {
    const collected = collectCredentials([{ provider: 'claude' }], lookup({}));

    expect(collected.isErr() && collected.error).toBeInstanceOf(CredentialsInvalid);
    for (const key of unwrap(AGENTS.claude.credentialKeys())) {
      expect(collected.isErr() && collected.error.message).toContain(key);
    }
  });

  it('asks for a model before it can tell which credential opencode needs', () => {
    const collected = collectCredentials([{ provider: 'opencode' }], lookup({}));

    expect(collected.isErr() && collected.error).toBeInstanceOf(ConfigInvalid);
  });
});

describe('AGENTS', () => {
  it('constructs Claude with the shared default when the step omits its model', () => {
    const options = { prompt: faker.lorem.sentence(), dangerouslySkipPermissions: true };
    const defaultCommand = unwrap(AGENTS.claude.create(undefined)).buildPrintCommand(options);
    const explicitCommand = unwrap(AGENTS.claude.create('opus')).buildPrintCommand(options);
    const otherCommand = unwrap(AGENTS.claude.create('sonnet')).buildPrintCommand(options);

    expect(defaultCommand).toEqual(explicitCommand);
    expect(defaultCommand).not.toEqual(otherCommand);
  });

  it("leaves every agent's transcripts in the sandbox instead of copying them to the host", () => {
    const model = `openrouter/${faker.word.noun()}`;

    for (const agent of Object.values(AGENTS)) {
      expect(unwrap(agent.create(model)).captureSessions).toBe(false);
    }
  });
});

function lookup(variables: Record<string, string>) {
  return (name: string): string | undefined => variables[name];
}
