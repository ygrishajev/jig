import { execa } from 'execa';
import { RemoteUnavailable } from '../domain/errors.js';
import { getCurrentBranch } from './branch.js';
import { isWorkingTreeClean, openRepo } from './repository.js';

/**
 * The branch's changes are in `intoBranch` when merging it there would leave the tree as it is,
 * which holds after a plain, a squash or a rebase merge alike. A branch with no commits of its own
 * has nothing left to land, so it counts as merged. When `intoBranch` tracks a remote, the remote's
 * copy is fetched and checked too, so a merge done on the host is seen before anyone pulls it.
 */
export async function isBranchMergedInto(
  repoRoot: string,
  branchName: string,
  intoBranch: string,
): Promise<boolean> {
  if (await mergeLeavesTreeAsIs(repoRoot, branchName, intoBranch)) return true;
  const upstream = await fetchUpstreamOf(repoRoot, intoBranch);
  return upstream !== undefined && mergeLeavesTreeAsIs(repoRoot, branchName, upstream);
}

async function mergeLeavesTreeAsIs(repoRoot: string, branchName: string, intoRef: string) {
  const merged = await git(repoRoot, ['merge-tree', '--write-tree', intoRef, branchName]);
  if (wouldConflict(merged)) return false;
  const [mergedTree] = succeeded(merged).split('\n');
  const baseTree = succeeded(await git(repoRoot, ['rev-parse', `${intoRef}^{tree}`]));
  return mergedTree === baseTree;
}

/** The ref of the branch's upstream after fetching it, or undefined when it tracks nothing. */
async function fetchUpstreamOf(repoRoot: string, branch: string) {
  const remote = await git(repoRoot, ['config', '--get', `branch.${branch}.remote`]);
  if (remote.exitCode === CONFIG_KEY_MISSING) return undefined;
  const mergeRef = succeeded(await git(repoRoot, ['config', '--get', `branch.${branch}.merge`]));
  const fetched = await git(repoRoot, ['fetch', '--quiet', succeeded(remote), mergeRef]);
  if (fetched.exitCode !== 0) {
    throw new RemoteUnavailable(`Fetching the upstream of "${branch}" failed: ${fetched.stderr}`);
  }
  return `${branch}@{upstream}`;
}

/** `git config --get` exits with this when the key is not set. */
const CONFIG_KEY_MISSING = 1;

/** `git merge-tree` exits with 1 both on conflicts and on errors; only a conflict still writes a tree. */
function wouldConflict(merged: GitResult) {
  return merged.exitCode === 1 && merged.stdout !== '';
}

type GitResult = Awaited<ReturnType<typeof git>>;

function git(cwd: string, args: string[]) {
  return execa('git', args, { cwd, reject: false });
}

function succeeded(result: GitResult) {
  if (result.exitCode !== 0) {
    throw new Error(`git ${result.command} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
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
