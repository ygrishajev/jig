import type { RunEvent, StepLocation } from '../domain/events.js';
import type { MetricRecord } from '../domain/metrics.js';
import type { Clock } from '../ports/observability.js';

/** Records one line per step, agent call and retry, attributing agent calls to the step they ran in. */
export class MetricsObserver {
  private location?: StepLocation;

  constructor(
    private readonly append: (record: MetricRecord) => void,
    private readonly clock: Clock,
  ) {}

  handle(event: RunEvent): void {
    const at = new Date(this.clock.now()).toISOString();
    switch (event.type) {
      case 'stepStarted':
        this.location = event.at;
        return;
      case 'stepFailed':
        this.location = undefined;
        return;
      case 'stepFinished':
        this.location = undefined;
        return this.append({
          kind: 'step',
          at,
          runId: event.runId,
          location: event.at,
          outcome: event.outcome.type,
          durationMs: event.durationMs,
          ...(event.outcome.type === 'implemented' ? { commit: event.outcome.commit } : {}),
        });
      case 'agentUsage':
        return this.append({
          kind: 'agentCall',
          at,
          runId: event.runId,
          location: this.location,
          role: event.role,
          costUsd: event.costUsd,
          tokens: event.tokens,
        });
      case 'stepRetried':
        return this.append({
          kind: 'retry',
          at,
          runId: event.runId,
          location: event.at,
          reason: event.reason,
        });
    }
  }
}
