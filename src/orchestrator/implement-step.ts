import type { AgentProvider } from '../strategies/provider/types.js';
import { checkoutExistingBranch, checkoutNewBranchAt, localBranchExists } from '../git/branch.js';
import { commitAll } from '../git/repository.js';
import { addWorktreeForNewBranch, worktreeExists } from '../git/worktree.js';
import type { RunPaths } from '../state/run-paths.js';
import type { Slice } from '../state/types.js';

export class ImplementStepFailedError extends Error {
  constructor(sliceId: string, providerOutput: string) {
    super(`Implement step failed for slice "${sliceId}": ${providerOutput}`);
  }
}

export interface ImplementStepInput {
  repoRoot: string;
  paths: RunPaths;
  slice: Slice;
  baseBranch: string;
  provider: AgentProvider;
  /** See config's `commitSigning: 'skip'` — passes the choice to worktree creation. */
  skipCommitSigning?: boolean;
}

export async function runImplementStep(input: ImplementStepInput): Promise<void> {
  const { repoRoot, paths, slice, baseBranch, provider, skipCommitSigning } = input;
  await ensureWorkspaceOnBranch(repoRoot, paths.workspaceDir, slice.branch, baseBranch, {
    skipCommitSigning,
  });

  const result = await provider.run({
    cwd: paths.workspaceDir,
    prompt: buildImplementPrompt(slice),
  });
  if (!result.success) {
    throw new ImplementStepFailedError(slice.id, result.output);
  }

  await commitAll(paths.workspaceDir, `sdlc: implement ${slice.id} — ${slice.title}`);
  slice.status = 'in_review';
}

function buildImplementPrompt(slice: Slice): string {
  const lines = [
    `You are implementing one slice of a larger, already-planned feature.`,
    '',
    `Slice: ${slice.title}`,
    `Description: ${slice.description}`,
  ];
  if (slice.lastFeedback) {
    lines.push(
      '',
      'A previous attempt at this slice was reviewed and changes were requested.',
      'Address this feedback specifically:',
      slice.lastFeedback,
    );
  }
  lines.push(
    '',
    'Make the necessary code changes in this repository to complete this slice.',
    'Do not commit — leave the changes in the working tree.',
  );
  return lines.join('\n');
}

async function ensureWorkspaceOnBranch(
  repoRoot: string,
  workspacePath: string,
  branchName: string,
  baseBranch: string,
  options: { skipCommitSigning?: boolean },
): Promise<void> {
  if (!(await worktreeExists(repoRoot, workspacePath))) {
    await addWorktreeForNewBranch(repoRoot, workspacePath, branchName, baseBranch, options);
    return;
  }
  if (await localBranchExists(repoRoot, branchName)) {
    await checkoutExistingBranch(workspacePath, branchName);
    return;
  }
  await checkoutNewBranchAt(workspacePath, branchName, baseBranch);
}
