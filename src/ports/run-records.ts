import type { Result } from 'better-result';

import type { RunId } from '../domain/run-id.js';
import type { TokenUsage } from '../domain/usage.js';
import type { MetricsLogCorrupt } from './run-state-failures.js';

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
