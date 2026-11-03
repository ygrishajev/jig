import { openRepo } from './repository.js';

export async function getCurrentBranch(cwd: string): Promise<string> {
  const status = await openRepo(cwd).status();
  if (!status.current) throw new Error(`Cannot determine current branch in ${cwd}`);
  return status.current;
}

/** Removes a local branch, merged or not; one that is already gone is left alone. */
export async function deleteBranch(cwd: string, name: string) {
  const git = openRepo(cwd);
  const { all } = await git.branchLocal();
  if (all.includes(name)) await git.deleteLocalBranch(name, true);
}
