import { faker } from '@faker-js/faker';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { configDestination } from '../filesystem/config-source.js';
import { BASE_DOCKERFILE, DOCKERFILE, SANDBOX_DIRECTORY } from './image-recipe.js';
import { RepositoryStarterFiles } from './starter-files.js';

describe('RepositoryStarterFiles', () => {
  it('starts a missing custom config where the operator named it, beside the sandbox Dockerfile', async () => {
    const customConfig = path.join(faker.word.noun(), `${faker.word.noun()}.json`);
    const { starterFiles, file, exists } = await setup({ customConfig });

    unwrap(await starterFiles.writeMissing());

    expect(JSON.parse(await file(customConfig))).toEqual({});
    expect(await file(path.join(SANDBOX_DIRECTORY, DOCKERFILE))).toBe(BASE_DOCKERFILE);
    expect(exists('jig.config.json')).toBe(false);
  });

  it('leaves a config the repository already has as it is', async () => {
    const customConfig = `${faker.word.noun()}.json`;
    const contents = JSON.stringify({ verifyCommand: `npm run ${faker.word.verb()}` });
    const { starterFiles, file } = await setup({ customConfig, existingConfig: contents });

    unwrap(await starterFiles.writeMissing());

    expect(await file(customConfig)).toBe(contents);
  });

  async function setup(input: { customConfig: string; existingConfig?: string }) {
    const repo = await createTempRepo();
    const configPath = path.join(repo.dir, input.customConfig);
    await mkdir(path.dirname(configPath), { recursive: true });
    if (input.existingConfig !== undefined) await writeFile(configPath, input.existingConfig);
    return {
      starterFiles: new RepositoryStarterFiles(
        repo.dir,
        configDestination(repo.dir, input.customConfig),
      ),
      file: (relativePath: string) => readFile(path.join(repo.dir, relativePath), 'utf-8'),
      exists: (relativePath: string) => existsSync(path.join(repo.dir, relativePath)),
    };
  }
});
