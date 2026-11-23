import { Result } from 'better-result';
import { execa, type ResultPromise } from 'execa';

import {
  GitCommandFailed,
  RemoteUnavailable,
  type RepositoryInvalid,
} from '../../ports/git-failures.js';
import { MergeFailed } from '../../ports/workspace.js';
import { messageOf } from '../exception-details.js';
import { getCurrentBranch } from './branch.js';
import { gitCommand, isWorkingTreeClean, openRepoWithoutHooks } from './repository.js';

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
): Promise<Result<boolean, GitCommandFailed | RemoteUnavailable>> {
  return Result.gen(async function* () {
    if (yield* Result.await(mergeLeavesTreeAsIs(repoRoot, branchName, intoBranch))) {
      return Result.ok(true);
    }
    const upstream = yield* Result.await(fetchUpstreamOf(repoRoot, intoBranch));
    if (upstream === undefined) return Result.ok(false);
    return Result.ok(yield* Result.await(mergeLeavesTreeAsIs(repoRoot, branchName, upstream)));
  });
}

async function mergeLeavesTreeAsIs(
  repoRoot: string,
  branchName: string,
  intoRef: string,
): Promise<Result<boolean, GitCommandFailed>> {
  const merged = await git(repoRoot, ['merge-tree', '--write-tree', intoRef, branchName]);
  if (wouldConflict(merged)) return Result.ok(false);
  const mergeOutput = succeeded(merged);
  if (mergeOutput.isErr()) return mergeOutput;
  const [mergedTree] = mergeOutput.value.split('\n');
  const baseTree = succeeded(await git(repoRoot, ['rev-parse', `${intoRef}^{tree}`]));
  return baseTree.map((tree) => mergedTree === tree);
}

function git(cwd: string, args: string[]): ResultPromise<{ reject: false }> {
  return execa('git', args, { cwd, reject: false });
}

type GitResult = Awaited<ReturnType<typeof git>>;

/** `git merge-tree` exits with 1 both on conflicts and on errors; only a conflict still writes a tree. */
function wouldConflict(merged: GitResult): boolean {
  return merged.exitCode === 1 && merged.stdout !== '';
}

function succeeded(result: GitResult): Result<string, GitCommandFailed> {
  if (result.exitCode === 0) return Result.ok(result.stdout.trim());
  return Result.err(
    new GitCommandFailed({
      message: `${result.command} failed: ${result.stderr}`,
      command: result.command,
      output: result.stderr,
    }),
  );
}

/** The ref of the branch's upstream after fetching it, or undefined when it tracks nothing. */
async function fetchUpstreamOf(
  repoRoot: string,
  branch: string,
): Promise<Result<string | undefined, GitCommandFailed | RemoteUnavailable>> {
  const remote = await git(repoRoot, ['config', '--get', `branch.${branch}.remote`]);
  if (remote.exitCode === CONFIG_KEY_MISSING) return Result.ok(undefined);
  const remoteName = succeeded(remote);
  if (remoteName.isErr()) return remoteName;
  const mergeRef = succeeded(await git(repoRoot, ['config', '--get', `branch.${branch}.merge`]));
  if (mergeRef.isErr()) return mergeRef;
  const fetched = await git(repoRoot, ['fetch', '--quiet', remoteName.value, mergeRef.value]);
  if (fetched.exitCode !== 0) {
    return Result.err(
      new RemoteUnavailable({
        message: `Fetching the upstream of "${branch}" failed: ${fetched.stderr}`,
      }),
    );
  }
  return Result.ok(`${branch}@{upstream}`);
}

/** `git config --get` exits with this when the key is not set. */
const CONFIG_KEY_MISSING = 1;

export async function mergeBranchInto(
  repoRoot: string,
  branchName: string,
  intoBranch: string,
  { sign = false }: { sign?: boolean } = {},
): Promise<Result<string, MergeFailed | GitCommandFailed>> {
  return Result.gen(async function* () {
    const currentBranch = yield* Result.await(
      getCurrentBranch(repoRoot).then((branch) => branch.mapError(asMergeFailed)),
    );
    if (currentBranch !== intoBranch) {
      return Result.err(
        new MergeFailed({
          message: `Refusing to merge: "${intoBranch}" is not checked out in ${repoRoot} (found "${currentBranch}")`,
        }),
      );
    }
    if (!(yield* Result.await(isWorkingTreeClean(repoRoot)))) {
      return Result.err(
        new MergeFailed({ message: `Refusing to merge: ${repoRoot} has uncommitted changes` }),
      );
    }
    const git = openRepoWithoutHooks(repoRoot, sign ? [] : ['commit.gpgsign=false']);
    yield* Result.await(
      Result.tryPromise({
        try: () => git.merge([branchName, '--no-edit', ...(sign ? ['--gpg-sign'] : [])]),
        catch: (error) => new MergeFailed({ message: messageOf(error) }),
      }),
    );
    return Result.ok(
      yield* Result.await(
        gitCommand('rev-parse', async () => (await git.revparse(['HEAD'])).trim()),
      ),
    );
  });
}

function asMergeFailed(
  error: RepositoryInvalid | GitCommandFailed,
): MergeFailed | GitCommandFailed {
  return GitCommandFailed.is(error) ? error : new MergeFailed({ message: error.message });
}
