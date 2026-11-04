import { Result } from 'better-result';

import { ConfigInvalid, type GitCommandFailed } from '../domain/errors.js';
import { gitCommand, openRepo } from './repository.js';

export async function getCurrentBranch(cwd: string): Promise<Result<string, ConfigInvalid>> {
  const status = await gitCommand('status', () => openRepo(cwd).status());
  if (status.isErr()) {
    return Result.err(
      new ConfigInvalid({
        message: `Cannot tell which branch is checked out in ${cwd}: ${status.error.output}`,
      }),
    );
  }
  if (!status.value.current || status.value.detached) {
    return Result.err(
      new ConfigInvalid({
        message: `${cwd} has no branch checked out — check out the branch the run should start from.`,
      }),
    );
  }
  return Result.ok(status.value.current);
}

/** Removes a local branch, merged or not; one that is already gone is left alone. */
export function deleteBranch(cwd: string, name: string): Promise<Result<void, GitCommandFailed>> {
  return gitCommand('branch -D', async () => {
    const git = openRepo(cwd);
    const { all } = await git.branchLocal();
    if (all.includes(name)) await git.deleteLocalBranch(name, true);
  });
}
