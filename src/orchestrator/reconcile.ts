import type { SdlcConfig } from '../config/load-config.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import type { MergeStrategy } from '../strategies/merge/types.js';
import type { RunPaths } from '../state/run-paths.js';
import type { SliceStatus } from '../state/types.js';
import { readRunMeta, readSlices, writeSlices } from '../state/store.js';
import { advanceRun } from './advance.js';
import { runImplementStep } from './implement-step.js';
import { runReviewStep } from './review-step.js';

export interface ReconcilePassInput {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
  provider: AgentProvider;
  config: SdlcConfig;
  mergeStrategy: MergeStrategy;
}

export interface ReconcilePassResult {
  blocked: boolean;
  reason?: string;
  complete: boolean;
}

export async function runReconcilerPass(input: ReconcilePassInput): Promise<ReconcilePassResult> {
  const { repoRoot, paths, baseBranch, provider, config, mergeStrategy } = input;
  const meta = await readRunMeta(paths);
  const slices = await readSlices(paths);
  const slice = slices.find((candidate) => candidate.id === meta.currentSliceId);

  if (!slice) {
    return {
      blocked: false,
      complete: slices.length > 0 && slices.every((s) => s.status === 'merged'),
    };
  }

  switch (slice.status) {
    case 'pending':
      await runImplementStep({ repoRoot, paths, slice, baseBranch, provider });
      break;
    case 'in_review':
      await runReviewStep({ paths, slice, provider, config });
      if ((slice.status as SliceStatus) === 'ready_to_merge') {
        // The review step approved the slice within this same pass. Persist
        // that transition before handing off to runAdvance — advanceRun reads
        // slices fresh from disk, so a stale on-disk "in_review" here would
        // make it skip the merge attempt and the test's final assertion of
        // "ready_to_merge" would also see stale state.
        await writeSlices(paths, slices);
        return runAdvance({ repoRoot, paths, baseBranch, mergeStrategy, sliceId: slice.id });
      }
      break;
    case 'ready_to_merge':
      // advanceRun persists slices/run-meta itself on success — it must not be
      // written again here with this function's now-stale in-memory `slices`,
      // or a just-recorded merge gets silently reverted to ready_to_merge.
      return runAdvance({ repoRoot, paths, baseBranch, mergeStrategy, sliceId: slice.id });
    case 'stuck':
      await writeSlices(paths, slices);
      return {
        blocked: true,
        reason: `slice "${slice.id}" is stuck — needs human intervention`,
        complete: false,
      };
    case 'implementing':
    case 'merged':
      break;
  }

  await writeSlices(paths, slices);
  return { blocked: false, complete: false };
}

async function runAdvance(input: {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
  mergeStrategy: MergeStrategy;
  sliceId: string;
}): Promise<ReconcilePassResult> {
  const { repoRoot, paths, baseBranch, mergeStrategy, sliceId } = input;
  try {
    const advanceResult = await advanceRun({ repoRoot, paths, baseBranch, mergeStrategy });
    if (!advanceResult.advanced) {
      return {
        blocked: true,
        reason: `slice "${sliceId}" is ready_to_merge (manual mode)`,
        complete: false,
      };
    }
    return { blocked: false, complete: advanceResult.complete };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      blocked: true,
      reason: `merge failed for slice "${sliceId}": ${message}`,
      complete: false,
    };
  }
}
