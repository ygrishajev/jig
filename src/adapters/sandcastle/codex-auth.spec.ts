import { faker } from '@faker-js/faker';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { openCodexAuthCache } from './codex-auth.js';

describe('Codex auth cache', () => {
  it('isolates only the login and preserves refreshed credentials on close', async () => {
    const { source, original } = await setup();
    await writeFile(path.join(source, 'config.toml'), faker.lorem.sentence());
    const cache = await openCodexAuthCache(source);
    expect(await readdir(cache.directory)).toEqual(['auth.json']);
    expect((await stat(cache.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(cache.directory, 'auth.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(cache.directory, 'auth.json'), 'utf8')).toBe(original);
    const refreshed = login();
    await writeFile(path.join(cache.directory, 'auth.json'), refreshed);
    await cache.close();
    expect(await readFile(path.join(source, 'auth.json'), 'utf8')).toBe(refreshed);
    await expect(readdir(cache.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a second run using the same login', async () => {
    const { source } = await setup();
    const cache = await openCodexAuthCache(source);
    try {
      await expect(openCodexAuthCache(source)).rejects.toThrow('in use');
    } finally {
      await cache.close();
    }
  });

  it('preserves a newer host login rather than overwriting it', async () => {
    const { source } = await setup();
    const cache = await openCodexAuthCache(source);
    const newer = login();
    await writeFile(path.join(source, 'auth.json'), newer);
    await writeFile(path.join(cache.directory, 'auth.json'), login());
    await expect(cache.close()).rejects.toThrow('changed during the run');
    expect(await readFile(path.join(source, 'auth.json'), 'utf8')).toBe(newer);
    await rm(cache.directory, { recursive: true, force: true });
  });

  it('rejects malformed credentials without including their contents in the error', async () => {
    const { source } = await setup();
    const secret = faker.string.alphanumeric(40);
    await writeFile(path.join(source, 'auth.json'), secret);
    await expect(openCodexAuthCache(source)).rejects.toThrow('Invalid Codex subscription login');
    await expect(openCodexAuthCache(source)).rejects.not.toThrow(secret);
  });

  async function setup() {
    const source = await tempDirectory();
    const original = login();
    await writeFile(path.join(source, 'auth.json'), original);
    return { source, original };
  }
});

function login() {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: faker.string.alphanumeric(40),
      id_token: faker.string.alphanumeric(40),
      refresh_token: faker.string.alphanumeric(40),
      account_id: faker.string.uuid(),
    },
    last_refresh: faker.date.recent().toISOString(),
  });
}
