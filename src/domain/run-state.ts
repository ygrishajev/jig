import type { RunId } from './run-id.js';
import type { Slice } from './slice.js';

export type RunPhase =
  | 'context'
  | 'planning'
  | 'designing'
  | 'slicing'
  | 'gate'
  | 'paused'
  | 'slices'
  | 'describing'
  | 'merging'
  | 'awaitingMerge'
  | 'done'
  | 'stuck';

export interface RunContext {
  classification: string;
  repoSummary: string;
}

export interface FeaturePlan {
  summary: string;
  approach: string;
  affectedAreas: string[];
}

export interface DesignDocs {
  design: string;
  plan: string;
}

export interface RunState {
  runId: RunId;
  /**
   * How many times the run has been saved. When several stores hold a copy, the highest revision
   * is the freshest: a counter rather than a timestamp, because the machines saving it do not
   * share a clock.
   */
  revision: number;
  baseBranch: string;
  request: string;
  phase: RunPhase;
  context?: RunContext;
  plan?: FeaturePlan;
  docs?: DesignDocs;
  slices: Slice[];
  prDescription?: string;
  blockedReason?: string;
}

export function startRun(input: { runId: RunId; baseBranch: string; request: string }): RunState {
  return { ...input, revision: 0, phase: 'context', slices: [] };
}

/** Every slice commits onto this one branch, so the whole feature lands as one merge. */
export function runBranchFor(runId: RunId) {
  return `sdlc/run/${runId}`;
}

/** Reads a field an earlier phase must have produced; a missing one means the flow is out of order. */
export function produced<K extends keyof RunState>(
  state: RunState,
  key: K,
): NonNullable<RunState[K]> {
  const value = state[key];
  if (value === undefined || value === null) {
    throw new Error(`Run ${state.runId} reached "${state.phase}" without its ${String(key)}`);
  }
  return value as NonNullable<RunState[K]>;
}

/** The first slice, by order, that has not been approved — a stuck slice stays current. */
export function currentSlice(state: RunState): Slice | undefined {
  return [...state.slices]
    .sort((a, b) => a.order - b.order)
    .find((slice) => slice.status !== 'approved');
}
