import type { AgentProvider } from '../strategies/provider/types.js';
import { checkoutExistingBranch, checkoutNewBranchAt, localBranchExists } from '../git/branch.js';
import { commitAll } from '../git/repository.js';
import { addWorktreeForNewBranch, worktreeExists } from '../git/worktree.js';
import type { RunPaths } from '../state/run-paths.js';
import { runBranchFor, type Slice } from '../state/types.js';
import { logRun } from '../logging.js';

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
  logRun(paths.runId, `preparing worktree for slice "${slice.id}"`);
  await ensureWorkspaceOnBranch(
    repoRoot,
    paths.workspaceDir,
    runBranchFor(paths.runId),
    baseBranch,
    {
      skipCommitSigning,
    },
  );
  logRun(paths.runId, `implementing slice "${slice.id}": ${slice.title}`);
  logRun(paths.runId, `worktree: ${paths.workspaceDir}`);

  const result = await provider.run({
    cwd: paths.workspaceDir,
    repoRoot,
    prompt: buildImplementPrompt(slice),
  });
  if (!result.success) {
    throw new ImplementStepFailedError(slice.id, result.output);
  }

  logRun(paths.runId, `committing slice "${slice.id}"`);
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
    '',
    'Before writing a script to re-derive something a tool already reported (e.g. parsing a',
    "mutation-testing or coverage tool's own output by hand), re-read what it already printed.",
    "Before re-running a slow check, check whether a later, more specific step already covers it",
    '(e.g. a full test-suite run right before a tool that re-runs the same suite itself).',
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
