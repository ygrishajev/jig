import { faker } from '@faker-js/faker';
import { mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { LocalPreparationFailed } from '../../ports/local-state.js';
import { CREDENTIALS_FILE, readCredentialsFile, saveCredential } from './credentials-file.js';

describe('credentials file', () => {
  it('reads nothing when the repository has no file', async () => {
    const { repoRoot } = await setup();

    expect(unwrap(readCredentialsFile(repoRoot))).toEqual({});
  });

  it('reads credentials the operator wrote by hand', async () => {
    const { repoRoot, file } = await setup();
    const [token, key] = [faker.string.alphanumeric(20), faker.string.alphanumeric(20)];
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `# saved by hand\nTOKEN=${token}\nexport KEY='${key}'\n`);

    expect(unwrap(readCredentialsFile(repoRoot))).toEqual({ TOKEN: token, KEY: key });
  });

  it('refuses a credentials path it cannot read as a file, naming it', async () => {
    const { repoRoot, file } = await setup();
    await mkdir(file, { recursive: true });

    const read = readCredentialsFile(repoRoot);

    expect(read.isErr() && read.error).toBeInstanceOf(LocalPreparationFailed);
    expect(read.isErr() && read.error.message).toContain(CREDENTIALS_FILE);
  });

  it('reads back what it saved, keeping the other credentials', async () => {
    const { repoRoot } = await setup();
    const [first, second] = [faker.string.alphanumeric(20), faker.string.alphanumeric(20)];

    unwrap(await saveCredential(repoRoot, 'FIRST', faker.string.alphanumeric(20)));
    unwrap(await saveCredential(repoRoot, 'SECOND', second));
    unwrap(await saveCredential(repoRoot, 'FIRST', first));

    expect(unwrap(readCredentialsFile(repoRoot))).toEqual({ FIRST: first, SECOND: second });
  });

  it('lets only the owner read the file', async () => {
    const { repoRoot, file } = await setup();

    unwrap(await saveCredential(repoRoot, 'KEY', faker.string.alphanumeric(20)));

    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('leaves git seeing nothing new in the repository', async () => {
    const { repoRoot, status } = await setup();

    unwrap(await saveCredential(repoRoot, 'KEY', faker.string.alphanumeric(20)));

    expect((await status()).isClean()).toBe(true);
  });

  it('refuses to save into a file git tracks, leaving it as it was', async () => {
    const { repoRoot, commitFile, status } = await setup();
    await commitFile();

    const saved = await saveCredential(repoRoot, 'KEY', faker.string.alphanumeric(20));

    expect(saved.isErr() && saved.error).toBeInstanceOf(LocalPreparationFailed);
    expect((await status()).isClean()).toBe(true);
  });

  it('refuses to read or write through a link', async () => {
    const { repoRoot, file } = await setup();
    const outside = path.join(await tempDirectory(), 'elsewhere');
    await writeFile(outside, 'KEY=value\n');
    await mkdir(path.dirname(file), { recursive: true });
    await symlink(outside, file);

    const read = readCredentialsFile(repoRoot);
    const saved = await saveCredential(repoRoot, 'KEY', faker.string.alphanumeric(20));

    expect(read.isErr() && read.error).toBeInstanceOf(LocalPreparationFailed);
    expect(saved.isErr() && saved.error).toBeInstanceOf(LocalPreparationFailed);
  });

  async function setup() {
    const repo = await createTempRepo();
    const file = path.join(repo.dir, CREDENTIALS_FILE);
    return {
      repoRoot: repo.dir,
      file,
      status: () => simpleGit({ baseDir: repo.dir }).status(),
      commitFile: async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'OTHER=value\n');
        await simpleGit({ baseDir: repo.dir }).add(['-f', CREDENTIALS_FILE]).commit('add');
      },
    };
  }
});
