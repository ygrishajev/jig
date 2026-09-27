import type { SdlcConfig } from '../config/load-config.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import type { MergeStrategy } from '../strategies/merge/types.js';
import type { RunPaths } from '../state/run-paths.js';
import type { RunMeta, Slice, SliceStatus } from '../state/types.js';
import { readRunMeta, readSlices, writeRunMeta, writeSlices } from '../state/store.js';
import { finalizeRun } from './finalize-run.js';
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
    if (slices.length === 0) return { blocked: false, complete: false };
    if (!slices.every((candidate) => candidate.status === 'merged')) {
      return { blocked: false, complete: false };
    }
    // Every slice has already been folded into the run branch — the only
    // thing left is the one merge of that branch into baseBranch.
    return finalizeRun({ repoRoot, paths, baseBranch, mergeStrategy });
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
        return advancePastSlice(
          { repoRoot, paths, baseBranch, mergeStrategy },
          slices,
          slice,
          meta,
        );
      }
      break;
    case 'ready_to_merge':
    case 'merged':
      // Routing both through the same helper is what makes this
      // self-healing instead of a dead end: two reachable paths (the
      // slice-planning provider returning zero slices, or duplicate slice
      // ids) can leave currentSliceId pointing at a slice that is already
      // 'merged'.
      return advancePastSlice({ repoRoot, paths, baseBranch, mergeStrategy }, slices, slice, meta);
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

/**
 * Marks `slice` done — folded into the run's single branch, which already
 * happened when it was committed, so there is nothing to merge per slice —
 * and moves currentSliceId to the next pending slice by order. Once no slice
 * remains, hands off to the one run-level merge in finalizeRun.
 */
async function advancePastSlice(
  input: { repoRoot: string; paths: RunPaths; baseBranch: string; mergeStrategy: MergeStrategy },
  slices: Slice[],
  slice: Slice,
  meta: RunMeta,
): Promise<ReconcilePassResult> {
  const { repoRoot, paths, baseBranch, mergeStrategy } = input;
  slice.status = 'merged';
  await writeSlices(paths, slices);
  const nextSlice = slices
    .filter((candidate) => candidate.status !== 'merged')
    .sort((a, b) => a.order - b.order)[0];
  await writeRunMeta(paths, {
    ...meta,
    currentSliceId: nextSlice?.id ?? null,
    updatedAt: new Date().toISOString(),
  });
  if (nextSlice) return { blocked: false, complete: false };
  return finalizeRun({ repoRoot, paths, baseBranch, mergeStrategy });
}
