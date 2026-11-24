import type { Result } from 'better-result';

import type { InvocationStatus } from '../domain/invocation-status.js';
import type { RunId } from '../domain/run-id.js';
import type { RunState } from '../domain/run-state.js';
import type { TokenUsage } from '../domain/usage.js';
import type { LocalStateUnwritable } from './local-state.js';
import type { MetricsLogCorrupt } from './run-state-failures.js';

/** The records a run keeps on this machine, and where an invocation leaves how it ended. */
export interface InvocationRecords extends RunRecords {
  /** Replaces the result and documents of the invocation that stopped with `status`. */
  recordInvocation(
    state: RunState,
    status: InvocationStatus,
    metrics: MetricsSummary,
  ): Promise<Result<void, LocalStateUnwritable>>;
}

/** This machine's record of the invocations it ran for a run, read without changing it. */
export interface RunRecords {
  /** The run's totals so far, across every invocation this machine ran. */
  metricsSummary(runId: RunId): Result<MetricsSummary, MetricsLogCorrupt>;
  /** The documents this machine holds for the run; a run that has not produced one has no file. */
  documents(runId: RunId): RunDocumentFile[];
}

export interface MetricsSummary {
  durationMs: number;
  steps: number;
  agentCalls: number;
  retries: number;
  reviewRounds: number;
  slicesCommitted: number;
  linesChanged: number;
  costUsd: number;
  tokens: TokenUsage;
}

export interface RunDocumentFile {
  name: RunDocument;
  path: string;
}

/** The markdown a run leaves for a person to read, in the order `jig status` lists them. */
export const RUN_DOCUMENTS = [
  'design.md',
  'plan.md',
  'design-review.md',
  'PR_DESCRIPTION.md',
] as const;

export type RunDocument = (typeof RUN_DOCUMENTS)[number];
