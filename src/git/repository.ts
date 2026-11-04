import { Result } from 'better-result';
import { realpath } from 'node:fs/promises';
import { type SimpleGit, simpleGit } from 'simple-git';

import { ConfigInvalid, GitCommandFailed, messageOf } from '../domain/errors.js';

/**
 * For a merge on the host: a hook can run what the branch just brought in, before anyone read it,
 * whether a tracked `post-merge` script or an install that runs a new `postinstall`. simple-git
 * guards this setting against untrusted values; this one is fixed and only turns hooks off.
 */
export function openRepoWithoutHooks(cwd: string): SimpleGit {
  return simpleGit({
    baseDir: cwd,
    config: ['core.hooksPath=/dev/null'],
    unsafe: { allowUnsafeHooksPath: true },
  });
}

export function isWorkingTreeClean(cwd: string): Promise<Result<boolean, GitCommandFailed>> {
  return gitCommand('status', async () => (await openRepo(cwd).status()).isClean());
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
