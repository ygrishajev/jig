import { faker } from '@faker-js/faker';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../tests/support/temp-directory.js';
import { ConfigInvalid } from '../domain/errors.js';
import { CONFIG_FILE } from './load-config.js';
import { updateConfigFile } from './write-config.js';

describe('updateConfigFile', () => {
  it('sets the given keys and keeps every other key as it was', async () => {
    const kept = { verifyCommand: `npm run ${faker.word.verb()}` };
    const setupCommand = `npm ${faker.word.verb()}`;
    const { repoRoot, read } = await setup(JSON.stringify(kept));

    const result = await updateConfigFile(repoRoot, { setupCommand });

    expect(result.isOk()).toBe(true);

    expect(await read()).toEqual({ ...kept, setupCommand });
  });

  it.each([
    ['a list', '[]'],
    ['not JSON', faker.lorem.word()],
  ])('refuses a config file that is %s instead of overwriting it', async (_case, contents) => {
    const { repoRoot } = await setup(contents);

    const result = await updateConfigFile(repoRoot, { setupCommand: faker.word.verb() });

    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
  });

  async function setup(contents: string) {
    const repoRoot = await tempDirectory('jig-write-config-');
    const file = path.join(repoRoot, CONFIG_FILE);
    await writeFile(file, contents);
    const read = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf-8'));
    return { repoRoot, read };
  }
});
