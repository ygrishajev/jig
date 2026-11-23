import type { AwilixContainer } from 'awilix';
import { Result } from 'better-result';

import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import type { RunDocumentFile } from '../adapters/local-store/run-artefacts.js';
import type { RunId } from '../domain/run-id.js';
import type { RunState } from '../domain/run-state.js';
import type { MetricsSummary } from '../observers/metrics.js';
import type { MetricsLogCorrupt } from '../ports/run-state-failures.js';
import type { RunStoreFailure } from '../ports/run-store.js';
import type { AppCradle } from './container.js';
import { RunRequestInvalid } from './errors.js';
import { openRunStore, type RunStoreSetupInvalid } from './run-stores.js';

export interface RunStatus {
  state: RunState;
  documents: RunDocumentFile[];
  metrics: MetricsSummary;
}

/** Why `readRunStatus` has no status to show. */
export type RunStatusFailure =
  RunStoreSetupInvalid | RunStoreFailure | RunRequestInvalid | MetricsLogCorrupt;

/**
 * Where a run is, read from the same stores a run saves to without changing any of them or this
 * machine's refs; metrics are this machine's.
 */
export async function readRunStatus(
  app: AwilixContainer<AppCradle>,
  runId: RunId,
): Promise<Result<RunStatus, RunStatusFailure>> {
  return Result.gen(async function* () {
    const store = yield* Result.await(openRunStore(app.cradle));
    const state = yield* Result.await(store.peek(runId));
    if (!state) {
      return Result.err(new RunRequestInvalid({ message: `No run found with id "${runId}".` }));
    }
    const { repoRoot, artefacts } = app.cradle;
    const metrics = yield* new MetricsLog(repoRoot, runId).summary();
    return Result.ok({ state, documents: artefacts.documents(runId), metrics });
  });
}
