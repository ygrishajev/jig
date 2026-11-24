import { Result } from 'better-result';

import type { RunId } from '../domain/run-id.js';
import type { RunState } from '../domain/run-state.js';
import type { MetricsSummary, RunDocumentFile, RunRecords } from '../ports/run-records.js';
import type { MetricsLogCorrupt } from '../ports/run-state-failures.js';
import type { RunStoreCatalog, RunStoreFailure, RunStoreSetupInvalid } from '../ports/run-store.js';
import { RunRequestInvalid } from './errors.js';
import {
  type OperationContext,
  prepareRepository,
  type RepositoryPreparationFailure,
  type RepositorySources,
} from './repository-preparation.js';
import { openRunStore } from './run-stores.js';

export interface StatusInput {
  runId: RunId;
  /** A config file other than the repository's own, relative to its root. */
  configPath?: string;
}

export interface RunStatus {
  state: RunState;
  documents: RunDocumentFile[];
  metrics: MetricsSummary;
}

/** Why `readRunStatus` has no status to show. */
export type RunStatusFailure =
  | RepositoryPreparationFailure
  | RunStoreSetupInvalid
  | RunStoreFailure
  | RunRequestInvalid
  | MetricsLogCorrupt;

export interface StatusCapabilities extends RepositorySources {
  context(): OperationContext;
  runRecordsAt(repoRoot: string): RunRecords;
  runStoresAt(repoRoot: string): RunStoreCatalog;
}

/**
 * Where a run is, read from the same stores a run saves to without changing any of them or this
 * machine's refs; metrics and documents are this machine's. It asks for no credential and starts
 * no sandbox, but still refuses an environment or saved credentials it cannot read.
 */
export function readRunStatus(
  capabilities: StatusCapabilities,
  { runId, configPath }: StatusInput,
): Promise<Result<RunStatus, RunStatusFailure>> {
  return Result.gen(async function* () {
    const { repoRoot, config } = yield* Result.await(
      prepareRepository(capabilities.context(), capabilities, configPath),
    );
    const store = yield* Result.await(openRunStore(capabilities.runStoresAt(repoRoot), config));
    const state = yield* Result.await(store.peek(runId));
    if (!state) {
      return Result.err(new RunRequestInvalid({ message: `No run found with id "${runId}".` }));
    }
    const records = capabilities.runRecordsAt(repoRoot);
    const metrics = yield* records.metricsSummary(runId);
    return Result.ok({ state, documents: records.documents(runId), metrics });
  });
}
