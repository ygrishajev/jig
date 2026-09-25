import { isBranchMergedInto } from '../git/merge.js';
import { readRunMeta, readSlices, writeRunMeta, writeSlices } from '../state/store.js';
import type { RunPaths } from '../state/run-paths.js';
import type { MergeStrategy } from '../strategies/merge/types.js';

export interface AdvanceInput {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
  mergeStrategy: MergeStrategy;
}

export interface AdvanceResult {
  advanced: boolean;
  currentSliceId: string | null;
  complete: boolean;
}

export async function advanceRun(input: AdvanceInput): Promise<AdvanceResult> {
  const { repoRoot, paths, baseBranch, mergeStrategy } = input;
  const meta = await readRunMeta(paths);
  const slices = await readSlices(paths);
  const currentSlice = slices.find((slice) => slice.id === meta.currentSliceId);

  if (!currentSlice) {
    return { advanced: false, currentSliceId: meta.currentSliceId, complete: slices.length > 0 };
  }

  if (currentSlice.status === 'ready_to_merge') {
    await mergeStrategy.merge(repoRoot, currentSlice, baseBranch);
  }

  if (!(await isBranchMergedInto(repoRoot, currentSlice.branch, baseBranch))) {
    return { advanced: false, currentSliceId: meta.currentSliceId, complete: false };
  }

  currentSlice.status = 'merged';
  const nextSlice = slices
    .filter((slice) => slice.status !== 'merged')
    .sort((a, b) => a.order - b.order)[0];
  const nextSliceId = nextSlice?.id ?? null;

  await writeSlices(paths, slices);
  await writeRunMeta(paths, {
    ...meta,
    currentSliceId: nextSliceId,
    updatedAt: new Date().toISOString(),
  });

  return { advanced: true, currentSliceId: nextSliceId, complete: nextSliceId === null };
}
