import type { AwilixContainer } from 'awilix';

import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import type { RunDocumentFile } from '../adapters/local-store/run-artefacts.js';
import { orThrow, RunRequestInvalid } from '../domain/errors.js';
import type { RunId } from '../domain/run-id.js';
import type { RunState } from '../domain/run-state.js';
import type { MetricsSummary } from '../observers/metrics.js';
import type { AppCradle } from './container.js';
import { openRunStore } from './run-stores.js';

export interface RunStatus {
  state: RunState;
  documents: RunDocumentFile[];
  metrics: MetricsSummary;
}

/**
 * Where a run is, read from the same stores a run saves to without changing any of them or this
 * machine's refs; metrics are this machine's.
 */
export async function readRunStatus(
  app: AwilixContainer<AppCradle>,
  runId: RunId,
): Promise<RunStatus> {
  const state = orThrow(await orThrow(await openRunStore(app.cradle)).peek(runId));
  if (!state) throw new RunRequestInvalid({ message: `No run found with id "${runId}".` });
  const { repoRoot, artefacts } = app.cradle;
  const documents = artefacts.documents(runId);
  const metrics = orThrow(new MetricsLog(repoRoot, runId).summary());
  return { state, documents, metrics };
}
