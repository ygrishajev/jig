import { Result } from 'better-result';
import { constants, readFileSync } from 'node:fs';
import { mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';

import { CodexLoginNotSaved, ConfigInvalid, messageOf } from '../../domain/errors.js';

export interface CodexAuthCache {
  directory: string;
  close(): Promise<Result<void, CodexLoginNotSaved>>;
}

/** What stops `location` from serving as a Codex login, if anything. */
export function codexLoginProblem(location: string): string | undefined {
  const file = codexLoginFile(location);
  const text = Result.try(() => readFileSync(file, 'utf8'));
  if (text.isErr()) return `No Codex login at ${file}: expected the auth.json of \`codex login\`.`;
  const valid = validateSubscription(text.value);
  return valid.isErr() ? valid.error.message : undefined;
}

/** An operator's path to a login: `~` is the home directory, and the file itself works too. */
function codexLoginFile(location: string): string {
  const expanded = location.replace(/^~(?=$|\/)/, homedir());
  return path.basename(expanded) === LOGIN_FILE ? expanded : path.join(expanded, LOGIN_FILE);
}

const LOGIN_FILE = 'auth.json';

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

/** Mounts only a private login copy; Codex can atomically refresh it without exposing host config. */
export async function openCodexAuthCache(
  location: string,
): Promise<Result<CodexAuthCache, ConfigInvalid>> {
  const source = await Result.tryPromise({
    try: () => realpath(codexLoginFile(location)),
    catch: (cause) =>
      new ConfigInvalid({
        message: `Could not find the Codex login in ${location}: ${messageOf(cause)}`,
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
  if (cache.isErr()) await releaseAfterFailedCopy(release.value);
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
      let copied = false;
      try {
        await writeFileAtomic(path.join(created, LOGIN_FILE), original.value, { mode: 0o600 });
        copied = true;
      } finally {
        if (!copied) await rm(created, { recursive: true, force: true });
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

async function persistAndRelease(
  source: string,
  original: string,
  directory: string,
  release: () => Promise<void>,
): Promise<Result<void, CodexLoginNotSaved>> {
  let persisted: Result<void, CodexLoginNotSaved>;
  let released: Result<void, CodexLoginNotSaved>;
  try {
    persisted = await persistOrDiscard(source, original, directory);
  } finally {
    released = await Result.tryPromise({
      try: () => release(),
      catch: (cause) =>
        new CodexLoginNotSaved({
          message: `Could not unlock the Codex login: ${messageOf(cause)}`,
        }),
    });
  }
  return persisted.isErr() ? persisted : released;
}

/** Hands a valid refresh back to the operator's login; the copy is kept only when that fails. */
async function persistOrDiscard(
  source: string,
  original: string,
  directory: string,
): Promise<Result<void, CodexLoginNotSaved>> {
  const refreshed = await Result.tryPromise({
    try: () => readRefreshedLogin(path.join(directory, 'auth.json')),
    catch: (cause) =>
      new CodexLoginNotSaved({
        message: `Could not read the refreshed Codex login: ${messageOf(cause)}`,
      }),
  });
  if (refreshed.isErr()) return keepFirstFailure(refreshed, await removeCopy(directory));
  const valid = validateSubscription(refreshed.value).mapError(
    (error) => new CodexLoginNotSaved({ message: error.message }),
  );
  const persisted =
    valid.isOk() && refreshed.value !== original
      ? await persistRefresh(source, original, refreshed.value, directory)
      : valid;
  const retained = persisted.isErr() && valid.isOk();
  return retained ? persisted : keepFirstFailure(persisted, await removeCopy(directory));
}

/**
 * The sandbox can write this directory, so the entry may be a link to any file on this machine.
 * Refusing the link while opening leaves no gap between checking the file and reading it.
 */
async function readRefreshedLogin(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function keepFirstFailure<T>(
  first: Result<T, CodexLoginNotSaved>,
  then: Result<void, CodexLoginNotSaved>,
): Result<void, CodexLoginNotSaved> {
  if (first.isErr()) return Result.err(first.error);
  return then;
}

/** The copy holds credentials, so one that cannot be removed is reported, not left behind quietly. */
function removeCopy(directory: string): Promise<Result<void, CodexLoginNotSaved>> {
  return Result.tryPromise({
    try: () => rm(directory, { recursive: true, force: true }),
    catch: (cause) =>
      new CodexLoginNotSaved({
        message: `Could not remove the copy of the Codex login at ${directory}: ${messageOf(cause)}`,
      }),
  });
}

async function persistRefresh(
  source: string,
  original: string,
  refreshed: string,
  directory: string,
): Promise<Result<void, CodexLoginNotSaved>> {
  const current = await Result.tryPromise({
    try: () => readFile(source, 'utf8'),
    catch: (cause) =>
      new CodexLoginNotSaved({ message: `Could not read the Codex login: ${messageOf(cause)}` }),
  });
  if (current.isErr()) return current.map(() => undefined);
  if (current.value !== original) {
    return Result.err(
      new CodexLoginNotSaved({
        message: `The Codex login changed during the run. Refreshed credentials are retained at ${directory}.`,
      }),
    );
  }
  return Result.tryPromise({
    try: () => writeFileAtomic(source, refreshed, { mode: 0o600 }),
    catch: (cause) =>
      new CodexLoginNotSaved({
        message: `Could not save the refreshed Codex login: ${messageOf(cause)}`,
      }),
  });
}

/** The copy already failed and is what the caller needs; proper-lockfile drops the lock at exit anyway. */
async function releaseAfterFailedCopy(release: () => Promise<void>): Promise<void> {
  await release().catch(() => undefined);
}
