import { faker } from '@faker-js/faker';
import { readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { codexLogin } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { CodexLoginNotSaved, SandboxCredentialsInvalid } from '../../ports/agent-session.js';
import { codexLoginProblem, openCodexAuthCache } from './codex-auth.js';

describe('Codex auth cache', () => {
  it('isolates only the login and preserves refreshed credentials on close', async () => {
    const { source, original } = await setup();
    await writeFile(path.join(source, 'config.toml'), faker.lorem.sentence());
    const cache = unwrap(await openCodexAuthCache(source));
    expect(await readdir(cache.directory)).toEqual(['auth.json']);
    expect((await stat(cache.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(cache.directory, 'auth.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(cache.directory, 'auth.json'), 'utf8')).toBe(original);
    const refreshed = codexLogin();
    await writeFile(path.join(cache.directory, 'auth.json'), refreshed);
    await cache.close();
    expect(await readFile(path.join(source, 'auth.json'), 'utf8')).toBe(refreshed);
    await expect(readdir(cache.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a second run using the same login', async () => {
    const { source } = await setup();
    const cache = unwrap(await openCodexAuthCache(source));
    try {
      const second = await openCodexAuthCache(source);

      expect(second.isErr() && second.error).toBeInstanceOf(SandboxCredentialsInvalid);
      expect(second.isErr() && second.error.message).toContain('in use');
    } finally {
      await cache.close();
    }
  });

  it('opens a login beside the lock file Codex leaves after a refresh', async () => {
    const { source } = await setup();
    await writeFile(path.join(source, 'auth.json.lock'), '');

    const cache = await openCodexAuthCache(source);

    expect(cache.isOk()).toBe(true);
    if (cache.isOk()) await cache.value.close();
  });

  it('preserves a newer host login rather than overwriting it', async () => {
    const { source } = await setup();
    const cache = unwrap(await openCodexAuthCache(source));
    const newer = codexLogin();
    await writeFile(path.join(source, 'auth.json'), newer);
    await writeFile(path.join(cache.directory, 'auth.json'), codexLogin());
    const closed = await cache.close();
    expect(closed.isErr() && closed.error).toBeInstanceOf(CodexLoginNotSaved);
    expect(closed.isErr() && closed.error.message).toContain('changed during the run');
    expect(await readFile(path.join(source, 'auth.json'), 'utf8')).toBe(newer);
    await rm(cache.directory, { recursive: true, force: true });
  });

  it('reports an invalid refreshed login, still removing the copy and releasing the lock', async () => {
    const { source } = await setup();
    const cache = unwrap(await openCodexAuthCache(source));
    await writeFile(path.join(cache.directory, 'auth.json'), faker.lorem.word());

    const closed = await cache.close();

    expect(closed.isErr() && closed.error).toBeInstanceOf(CodexLoginNotSaved);
    await expect(readdir(cache.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await openCodexAuthCache(source)).isOk()).toBe(true);
  });

  it('keeps the selected login when the refreshed copy is a link to another login', async () => {
    const { source, original } = await setup();
    const otherLogin = path.join(await tempDirectory(), 'auth.json');
    await writeFile(otherLogin, codexLogin());
    const cache = unwrap(await openCodexAuthCache(source));
    await rm(path.join(cache.directory, 'auth.json'));
    await symlink(otherLogin, path.join(cache.directory, 'auth.json'));

    const closed = await cache.close();

    expect(await readFile(path.join(source, 'auth.json'), 'utf8')).toBe(original);
    expect(closed.isErr() && closed.error).toBeInstanceOf(CodexLoginNotSaved);
    await expect(readdir(cache.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await openCodexAuthCache(source)).isOk()).toBe(true);
  });

  it('rejects malformed credentials without including their contents in the error', async () => {
    const { source } = await setup();
    const secret = faker.string.alphanumeric(40);
    await writeFile(path.join(source, 'auth.json'), secret);

    const opened = await openCodexAuthCache(source);

    expect(opened.isErr() && opened.error).toBeInstanceOf(SandboxCredentialsInvalid);
    expect(opened.isErr() && opened.error.message).toContain('Invalid Codex subscription login');
    expect(opened.isErr() && opened.error.message).not.toContain(secret);
  });

  it('opens a login named by its file as well as by its directory', async () => {
    const { source, original } = await setup();

    const cache = unwrap(await openCodexAuthCache(path.join(source, 'auth.json')));

    expect(await readFile(path.join(cache.directory, 'auth.json'), 'utf8')).toBe(original);
    await cache.close();
  });

  describe('codexLoginProblem', () => {
    it('accepts a directory holding a login, or the login file itself', async () => {
      const { source } = await setup();

      expect(codexLoginProblem(source)).toBeUndefined();
      expect(codexLoginProblem(path.join(source, 'auth.json'))).toBeUndefined();
    });

    it('reads a leading ~ as the home directory', () => {
      const missing = faker.string.uuid();

      expect(codexLoginProblem(`~/${missing}`)).toContain(
        path.join(homedir(), missing, 'auth.json'),
      );
    });

    it('names the file it looked for when there is no login', async () => {
      const directory = await tempDirectory();

      expect(codexLoginProblem(directory)).toContain(path.join(directory, 'auth.json'));
    });

    it('rejects a login without the full token bundle, without repeating it', async () => {
      const { source } = await setup();
      const secret = faker.string.alphanumeric(40);
      await writeFile(path.join(source, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: secret }));

      const problem = codexLoginProblem(source);

      expect(problem).toContain('Invalid Codex subscription login');
      expect(problem).not.toContain(secret);
    });
  });

  async function setup() {
    const source = await tempDirectory();
    const original = codexLogin();
    await writeFile(path.join(source, 'auth.json'), original);
    return { source, original };
  }
});
