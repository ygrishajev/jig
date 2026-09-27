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
  /** Used for the review step, and for implement when `implementProvider` is unset. */
  provider: AgentProvider;
  /** Overrides `provider` for the implement step only — see `implementProviderCommand`. */
  implementProvider?: AgentProvider;
  config: SdlcConfig;
  mergeStrategy: MergeStrategy;
}

export interface ReconcilePassResult {
  blocked: boolean;
  reason?: string;
  complete: boolean;
}

export async function runReconcilerPass(input: ReconcilePassInput): Promise<ReconcilePassResult> {
  const { repoRoot, paths, baseBranch, provider, implementProvider, config, mergeStrategy } = input;
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
      await runImplementStep({
        repoRoot,
        paths,
        slice,
        baseBranch,
        provider: implementProvider ?? provider,
        skipCommitSigning: config.commitSigning === 'skip',
      });
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
    case 'merged':
      // advanceRun persists slices/run-meta itself on success — it must not be
      // written again here with this function's now-stale in-memory `slices`,
      // or a just-recorded merge gets silently reverted to ready_to_merge.
      //
      // Routing 'merged' through the same helper is what makes it
      // self-healing instead of a dead end: two reachable paths (the
      // slice-planning provider returning zero slices, or duplicate slice
      // ids) can leave currentSliceId pointing at a slice that is already
      // 'merged'. advanceRun skips the merge attempt for a non-ready slice,
      // sees isBranchMergedInto is already true, and advances to the next
      // pending slice or reports the run complete.
      return runAdvance({ repoRoot, paths, baseBranch, mergeStrategy, sliceId: slice.id });
    case 'stuck':
      await writeSlices(paths, slices);
      return {
        blocked: true,
        reason: `slice "${slice.id}" is stuck — needs human intervention`,
        complete: false,
      };
    case 'implementing':
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
      // Reached both when manual mode hasn't merged the branch yet, and when
      // an already-'merged' slice routed here via the self-healing case below
      // still isn't detected as merged into baseBranch — so this can't claim
      // a specific mode or cause.
      return {
        blocked: true,
        reason: `slice "${sliceId}" is not yet merged into "${baseBranch}"`,
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
