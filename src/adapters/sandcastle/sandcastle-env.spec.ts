import { faker } from '@faker-js/faker';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { sandcastleEnvKeys } from './sandcastle-env.js';

describe('sandcastleEnvKeys', () => {
  it('names every variable the file would inject, without their values', async () => {
    const secret = faker.string.alphanumeric(40);
    const { repoRoot, writeEnvFile } = await setup();
    await writeEnvFile(
      [
        '  # OLD_TOKEN=revoked',
        '',
        `GITHUB_TOKEN=${secret}`,
        ' EMPTY_HERE = ',
        'not a variable',
      ].join('\n'),
    );

    const keys = await sandcastleEnvKeys(repoRoot);

    expect(keys).toEqual(['GITHUB_TOKEN', 'EMPTY_HERE']);
    expect(keys.join()).not.toContain(secret);
  });

  it('names nothing when the repository has no such file', async () => {
    const { repoRoot } = await setup();

    expect(await sandcastleEnvKeys(repoRoot)).toEqual([]);
  });

  async function setup() {
    const repoRoot = await tempDirectory('sdlc-sandcastle-env-');
    const writeEnvFile = async (content: string) => {
      await mkdir(path.join(repoRoot, '.sandcastle'), { recursive: true });
      await writeFile(path.join(repoRoot, '.sandcastle', '.env'), content);
    };
    return { repoRoot, writeEnvFile };
  }
});
