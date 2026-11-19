import { faker } from '@faker-js/faker';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { ConfigInvalid } from '../domain/errors.js';
import { configFileFor, loadConfig } from './load-config.js';
import { updateConfigFile } from './write-config.js';

describe('updateConfigFile', () => {
  it('sets the given keys and keeps every other key as it was', async () => {
    const kept = { verifyCommand: `npm run ${faker.word.verb()}` };
    const setupCommand = `npm ${faker.word.verb()}`;
    const { configFile, read } = await setup(JSON.stringify(kept));

    const result = await updateConfigFile(configFile, { setupCommand });

    expect(result.isOk()).toBe(true);

    expect(await read()).toEqual({ ...kept, setupCommand });
  });

  it('round trips provider selections without serializing inferred models', async () => {
    const steps = {
      planner: { provider: 'claude' },
      implementer: { provider: 'codex', model: faker.word.noun() },
      reviewer: { provider: 'opencode', model: `openrouter/${faker.word.noun()}` },
    };
    const { configFile, read } = await setup('{}');

    unwrap(await updateConfigFile(configFile, steps));

    expect(await read()).toEqual(steps);
    expect(unwrap(loadConfig(configFile))).toMatchObject(steps);
    expect(unwrap(loadConfig(configFile)).planner?.model).toBeUndefined();
  });

  it.each([
    ['a list', '[]'],
    ['not JSON', faker.lorem.word()],
  ])('refuses a config file that is %s instead of overwriting it', async (_case, contents) => {
    const { configFile } = await setup(contents);

    const result = await updateConfigFile(configFile, { setupCommand: faker.word.verb() });

    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
  });

  async function setup(contents: string) {
    const repoRoot = await tempDirectory('jig-write-config-');
    const configFile = configFileFor(repoRoot, `${faker.word.noun()}.json`);
    await writeFile(configFile.path, contents);
    const read = async (): Promise<unknown> => JSON.parse(await readFile(configFile.path, 'utf-8'));
    return { configFile, read };
  }
});
