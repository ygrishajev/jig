import { getCurrentBranch } from './branch.js';
import { isWorkingTreeClean, openRepo } from './repository.js';

export async function isBranchMergedInto(
  repoRoot: string,
  branchName: string,
  intoBranch: string,
): Promise<boolean> {
  try {
    const log = await openRepo(repoRoot).log([`${intoBranch}..${branchName}`]);
    return log.total === 0;
  } catch {
    return false;
  }
}

export async function mergeBranchInto(
  repoRoot: string,
  branchName: string,
  intoBranch: string,
): Promise<string> {
  const currentBranch = await getCurrentBranch(repoRoot);
  if (currentBranch !== intoBranch) {
    throw new Error(
      `Refusing to merge: "${intoBranch}" is not checked out in ${repoRoot} (found "${currentBranch}")`,
    );
  }
  if (!(await isWorkingTreeClean(repoRoot))) {
    throw new Error(`Refusing to merge: ${repoRoot} has uncommitted changes`);
  }
  const git = openRepo(repoRoot);
  await git.merge([branchName, '--no-edit']);
  const log = await git.log(['-1']);
  if (!log.latest) throw new Error('Merge succeeded but produced no commit');
  return log.latest.hash;
}
