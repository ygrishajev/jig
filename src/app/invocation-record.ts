import { type InvocationStatus, outcomeIsComplete } from '../domain/invocation-status.js';
import type { MetricsSummary } from '../domain/metrics.js';
import { type RunState, runStopReason } from '../domain/run-state.js';
import type { InvocationRecord, InvocationResult } from '../ports/run-records.js';
import { runDocumentContents } from './run-documents.js';

/** What this machine keeps of an invocation that stopped with `status`. */
export function invocationRecord(
  state: RunState,
  status: InvocationStatus,
  metrics: MetricsSummary,
): InvocationRecord {
  return {
    runId: state.runId,
    result: invocationResult(state, status, metrics),
    documents: runDocumentContents(state, metrics),
  };
}

/** `complete` and `blockedReason` keep the shape earlier workflows read. */
function invocationResult(
  state: RunState,
  status: InvocationStatus,
  metrics: MetricsSummary,
): InvocationResult {
  return {
    status,
    phase: state.phase,
    complete: outcomeIsComplete(status),
    blockedReason: state.blockedReason ?? runStopReason(state),
    metrics,
  };
}
