import { existsSync } from 'node:fs';
import path from 'node:path';
import { openRepo } from '../git/repository.js';
import { readRunMeta, readSlices } from '../state/store.js';
import type { RunPaths } from '../state/run-paths.js';

export interface RunSummaryInput {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
}

/**
 * Prints where the run's code lives (the slice worktree) and what the current
 * slice contributed (its commits over the base branch), so a blocked or
 * finished run can be picked up without digging through state files.
 */
export async function printRunSummary(input: RunSummaryInput): Promise<void> {
  const { repoRoot, paths, baseBranch } = input;
  console.log(`Worktree: ${paths.workspaceDir}`);
  for (const [label, filename] of [
    ['Design', 'design.md'],
    ['Plan', 'plan.md'],
  ] as const) {
    const docPath = path.join(paths.stateDir, filename);
    if (existsSync(docPath)) console.log(`${label}: ${docPath}`);
  }

  const meta = await readRunMeta(paths);
  const slices = await readSlices(paths);
  const current = slices.find((slice) => slice.id === meta.currentSliceId);
  if (!current) return;

  console.log(`Commits on slice branch (not in ${baseBranch}):`);
  let log;
  try {
    log = await openRepo(repoRoot).log([`${baseBranch}..${current.branch}`]);
  } catch {
    console.log('  (none)');
    return;
  }
  if (log.total === 0) {
    console.log('  (none)');
    return;
  }
  for (const commit of log.all) {
    console.log(`  ${commit.hash.slice(0, 7)} ${commit.message.split('\n')[0]}`);
  }
}
