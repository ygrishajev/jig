import { Result } from 'better-result';
import { realpath } from 'node:fs/promises';
import { type SimpleGit, simpleGit } from 'simple-git';

import { ConfigInvalid, GitCommandFailed, messageOf } from '../domain/errors.js';

export async function commitAll(
  cwd: string,
  message: string,
): Promise<Result<string | null, GitCommandFailed>> {
  return gitCommand('commit', async () => {
    const git = openRepo(cwd);
    if ((await git.status()).isClean()) return null;
    await git.add('-A');
    return (await git.commit(message)).commit;
  });
}

/** Runs simple-git work, returning whatever it throws as a failed git command. */
export function gitCommand<T>(
  command: string,
  run: () => Promise<T>,
): Promise<Result<T, GitCommandFailed>> {
  return Result.tryPromise({
    try: run,
    catch: (error) =>
      new GitCommandFailed({
        message: `git ${command} failed: ${messageOf(error)}`,
        command,
        stderr: messageOf(error),
      }),
  });
}

export function openRepo(cwd: string): SimpleGit {
  return simpleGit({ baseDir: cwd });
}

export function isWorkingTreeClean(cwd: string): Promise<Result<boolean, GitCommandFailed>> {
  return gitCommand('status', async () => (await openRepo(cwd).status()).isClean());
}

/**
 * jig works on the repository in the directory it was started in. Started further down, it would
 * miss the config and hand the sandbox no git directory, so that is refused; a directory that is
 * not a repository yet is left for `init` and git itself to judge.
 */
export async function ensureRepositoryRoot(cwd: string): Promise<Result<void, ConfigInvalid>> {
  const root = await openRepo(cwd)
    .revparse(['--show-toplevel'])
    .catch(() => undefined);
  if (root === undefined || root === (await realpath(cwd))) return Result.ok();
  return Result.err(
    new ConfigInvalid({
      message: `Run jig from the repository's root, ${root} — not from ${cwd}.`,
    }),
  );
}
