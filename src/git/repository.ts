import { realpath } from 'node:fs/promises';
import { type SimpleGit, simpleGit } from 'simple-git';

import { ConfigInvalid } from '../domain/errors.js';

export async function commitAll(cwd: string, message: string): Promise<string | null> {
  const git = openRepo(cwd);
  if (await isWorkingTreeClean(cwd)) return null;
  await git.add('-A');
  const result = await git.commit(message);
  return result.commit;
}

export function openRepo(cwd: string): SimpleGit {
  return simpleGit({ baseDir: cwd });
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const status = await openRepo(cwd).status();
  return status.isClean();
}

/**
 * jig works on the repository in the directory it was started in. Started further down, it would
 * miss the config and hand the sandbox no git directory, so that is refused; a directory that is
 * not a repository yet is left for `init` and git itself to judge.
 */
export async function ensureRepositoryRoot(cwd: string): Promise<void> {
  const root = await openRepo(cwd)
    .revparse(['--show-toplevel'])
    .catch(() => undefined);
  if (root === undefined || root === (await realpath(cwd))) return;
  throw new ConfigInvalid({
    message: `Run jig from the repository's root, ${root} — not from ${cwd}.`,
  });
}
