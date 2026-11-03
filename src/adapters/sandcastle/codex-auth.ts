import { Result } from 'better-result';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';

import { ConfigInvalid, messageOf, orThrow } from '../../domain/errors.js';

export interface CodexAuthCache {
  directory: string;
  close(): Promise<void>;
}

/** Mounts only a private login copy; Codex can atomically refresh it without exposing host config. */
export async function openCodexAuthCache(
  sourceDirectory: string,
): Promise<Result<CodexAuthCache, ConfigInvalid>> {
  const source = await Result.tryPromise({
    try: () => realpath(path.join(sourceDirectory, 'auth.json')),
    catch: (cause) =>
      new ConfigInvalid({
        message: `Could not find the Codex login in ${sourceDirectory}: ${messageOf(cause)}`,
      }),
  });
  if (source.isErr()) return source;
  const release = await Result.tryPromise({
    try: () => lockfile.lock(source.value, { retries: 0 }),
    catch: () =>
      new ConfigInvalid({
        message: 'The Codex login is in use or cannot be locked. Serialize runs using this login.',
      }),
  });
  if (release.isErr()) return release;
  const cache = await copyLogin(source.value, release.value);
  if (cache.isErr()) await release.value();
  return cache;
}

async function copyLogin(
  source: string,
  release: () => Promise<void>,
): Promise<Result<CodexAuthCache, ConfigInvalid>> {
  const original = await Result.tryPromise({
    try: () => readFile(source, 'utf8'),
    catch: (cause) =>
      new ConfigInvalid({ message: `Could not read the Codex login: ${messageOf(cause)}` }),
  });
  if (original.isErr()) return original;
  const valid = validateSubscription(original.value);
  if (valid.isErr()) return valid;
  const directory = await Result.tryPromise({
    try: async () => {
      const created = await mkdtemp(path.join(tmpdir(), 'jig-codex-auth-'));
      try {
        await writeFileAtomic(path.join(created, 'auth.json'), original.value, { mode: 0o600 });
      } catch (error) {
        await rm(created, { recursive: true, force: true });
        throw error;
      }
      return created;
    },
    catch: (cause) =>
      new ConfigInvalid({ message: `Could not copy the Codex login: ${messageOf(cause)}` }),
  });
  return directory.map((copy) => ({
    directory: copy,
    close: () => persistAndRelease(source, original.value, copy, release),
  }));
}

function validateSubscription(text: string): Result<void, ConfigInvalid> {
  const value = Result.try(() => JSON.parse(text) as unknown);
  if (value.isErr()) {
    return Result.err(new ConfigInvalid({ message: 'Invalid Codex subscription login JSON.' }));
  }
  return subscriptionSchema.safeParse(value.value).success
    ? Result.ok()
    : Result.err(
        new ConfigInvalid({
          message: 'Invalid Codex subscription login: expected the full ChatGPT token bundle.',
        }),
      );
}

const subscriptionSchema = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  tokens: z.object({
    access_token: z.string().min(1),
    id_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});

async function persistAndRelease(
  source: string,
  original: string,
  directory: string,
  release: () => Promise<void>,
): Promise<void> {
  try {
    const refreshed = await readFile(path.join(directory, 'auth.json'), 'utf8');
    orThrow(validateSubscription(refreshed));
    if (refreshed !== original) await persistRefresh(source, original, refreshed, directory);
    await rm(directory, { recursive: true, force: true });
  } finally {
    await release();
  }
}

async function persistRefresh(
  source: string,
  original: string,
  refreshed: string,
  directory: string,
): Promise<void> {
  if ((await readFile(source, 'utf8')) !== original) {
    throw new ConfigInvalid({
      message: `The Codex login changed during the run. Refreshed credentials are retained at ${directory}.`,
    });
  }
  await writeFileAtomic(source, refreshed, { mode: 0o600 });
}
