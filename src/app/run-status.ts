import type { AwilixContainer } from 'awilix';
import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import type { RunDocument } from '../adapters/local-store/run-artefacts.js';
import { RunRequestInvalid } from '../domain/errors.js';
import type { RunId } from '../domain/run-id.js';
import type { RunState } from '../domain/run-state.js';
import { summarizeMetrics, type MetricsSummary } from '../observers/metrics.js';
import type { AppCradle } from './container.js';
import { openRunStore } from './run-stores.js';

const DOCUMENTS: RunDocument[] = ['design.md', 'plan.md', 'PR_DESCRIPTION.md'];

export interface RunStatus {
  state: RunState;
  documents: { name: RunDocument; path: string }[];
  metrics: MetricsSummary;
}

/** Where a run is, read from the same stores a run saves to; metrics are this machine's. */
export async function readRunStatus(
  app: AwilixContainer<AppCradle>,
  runId: RunId,
): Promise<RunStatus> {
  const state = await (await openRunStore(app.cradle)).load(runId);
  if (!state) throw new RunRequestInvalid(`No run found with id "${runId}".`);
  const { repoRoot, artefacts } = app.cradle;
  const documents = DOCUMENTS.flatMap((name) => {
    const found = artefacts.documentPath(runId, name);
    return found ? [{ name, path: found }] : [];
  });
  const metrics = summarizeMetrics(new MetricsLog(repoRoot, runId).readAll());
  return { state, documents, metrics };
}
