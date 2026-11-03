import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';

import { ConfigInvalid } from '../../domain/errors.js';

const subscriptionSchema = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  tokens: z.object({
    access_token: z.string().min(1),
    id_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});

export interface CodexAuthCache {
  directory: string;
  close(): Promise<void>;
}

/** Mounts only a private login copy; Codex can atomically refresh it without exposing host config. */
export async function openCodexAuthCache(sourceDirectory: string): Promise<CodexAuthCache> {
  const source = await realpath(path.join(sourceDirectory, 'auth.json'));
  const release = await lockfile.lock(source, { retries: 0 }).catch(() => {
    throw new ConfigInvalid(
      'The Codex login is in use or cannot be locked. Serialize runs using this login.',
    );
  });
  let directory: string | undefined;
  try {
    const original = await readFile(source, 'utf8');
    validateSubscription(original);
    directory = await mkdtemp(path.join(tmpdir(), 'jig-codex-auth-'));
    await writeFileAtomic(path.join(directory, 'auth.json'), original, { mode: 0o600 });
    const cache = directory;
    return { directory: cache, close: () => persistAndRelease(source, original, cache, release) };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    await release();
    throw error;
  }
}

async function persistAndRelease(
  source: string,
  original: string,
  directory: string,
  release: () => Promise<void>,
) {
  try {
    const refreshed = await readFile(path.join(directory, 'auth.json'), 'utf8');
    validateSubscription(refreshed);
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
) {
  if ((await readFile(source, 'utf8')) !== original) {
    throw new ConfigInvalid(
      `The Codex login changed during the run. Refreshed credentials are retained at ${directory}.`,
    );
  }
  await writeFileAtomic(source, refreshed, { mode: 0o600 });
}

function validateSubscription(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConfigInvalid('Invalid Codex subscription login JSON.');
  }
  if (!subscriptionSchema.safeParse(value).success) {
    throw new ConfigInvalid(
      'Invalid Codex subscription login: expected the full ChatGPT token bundle.',
    );
  }
}
