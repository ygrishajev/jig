import type { Result } from 'better-result';

import type { MetricsSummary } from '../../domain/metrics.js';
import type { RunId } from '../../domain/run-id.js';
import type { LocalStateUnwritable } from '../../ports/local-state.js';
import type {
  InvocationRecord,
  InvocationRecords,
  RunDocumentFile,
} from '../../ports/run-records.js';
import type { MetricsLogCorrupt } from '../../ports/run-state-failures.js';
import { MetricsLog } from './metrics-log.js';
import { RunArtefacts } from './run-artefacts.js';

/** What `.jig/<id>/state/` holds for a run on this machine: its metrics log and its documents. */
export class LocalRunRecords implements InvocationRecords {
  private readonly artefacts: RunArtefacts;

  constructor(private readonly repoRoot: string) {
    this.artefacts = new RunArtefacts(repoRoot);
  }

  metricsSummary(runId: RunId): Result<MetricsSummary, MetricsLogCorrupt> {
    return new MetricsLog(this.repoRoot, runId).summary();
  }

  documents(runId: RunId): RunDocumentFile[] {
    return this.artefacts.documents(runId);
  }

  recordInvocation(invocation: InvocationRecord): Promise<Result<void, LocalStateUnwritable>> {
    return this.artefacts.write(invocation);
  }
}
