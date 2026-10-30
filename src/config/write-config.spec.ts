import { faker } from '@faker-js/faker';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigInvalid } from '../domain/errors.js';
import { CONFIG_FILE } from './load-config.js';
import { updateConfigFile } from './write-config.js';

describe('updateConfigFile', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

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
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'sdlc-write-config-'));
    directories.push(repoRoot);
    const file = path.join(repoRoot, CONFIG_FILE);
    await writeFile(file, contents);
    const read = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf-8'));
    return { repoRoot, read };
  }
});
