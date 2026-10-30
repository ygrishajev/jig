import { faker } from '@faker-js/faker';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigInvalid } from '../domain/errors.js';
import { CONFIG_FILE } from './load-config.js';
import { updateConfigFile } from './write-config.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';

describe('updateConfigFile', () => {
  it('sets the given keys and keeps every other key as it was', async () => {
    const kept = { verifyCommand: `npm run ${faker.word.verb()}` };
    const setupCommand = `npm ${faker.word.verb()}`;
    const { repoRoot, read } = await setup(JSON.stringify(kept));

    await updateConfigFile(repoRoot, { setupCommand });

    expect(await read()).toEqual({ ...kept, setupCommand });
  });

  it.each([
    ['a list', '[]'],
    ['not JSON', faker.lorem.word()],
  ])('refuses a config file that is %s instead of overwriting it', async (_case, contents) => {
    const { repoRoot } = await setup(contents);

    await expect(
      updateConfigFile(repoRoot, { setupCommand: faker.word.verb() }),
    ).rejects.toBeInstanceOf(ConfigInvalid);
  });

  async function setup(contents: string) {
    const repoRoot = await tempDirectory('sdlc-write-config-');
    const file = path.join(repoRoot, CONFIG_FILE);
    await writeFile(file, contents);
    const read = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf-8'));
    return { repoRoot, read };
  }
});
