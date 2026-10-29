import type { Logger } from 'pino';
import type { RunEvent, StepLocation } from '../domain/events.js';

/** Turns run events into log lines: a readable message, with the event's data as fields. */
export class LoggingObserver {
  constructor(private readonly logger: Logger) {}

  handle(event: RunEvent) {
    const { type, ...fields } = event;
    const log = this.logger.child({ event: type });
    switch (event.type) {
      case 'runResumed':
        return log.info(fields, `run ${event.runId} at ${event.phase}`);
      case 'stepStarted':
        return log.info(fields, `${describe(event.at)}…`);
      case 'stepFinished':
        return log.info(
          fields,
          `${describe(event.at)} → ${event.outcome} (${seconds(event.durationMs)})`,
        );
      case 'stepRetried':
        return log.warn(
          fields,
          `${describe(event.at)} failed, retrying (attempt ${event.attempt}): ${event.reason}`,
        );
      case 'phaseChanged':
        return log.debug(fields, `${event.from} → ${event.to}`);
      case 'sliceStatusChanged':
        return log.info(fields, `slice ${event.sliceId}: ${event.from} → ${event.to}`);
      case 'runHalted':
        return log.info(fields, `run ${event.runId} waiting at ${event.phase}`);
      case 'runBlocked':
        return log.error(fields, `run ${event.runId} blocked at ${event.phase}: ${event.reason}`);
      case 'runFinished':
        return log.info(fields, `run ${event.runId} finished: ${event.phase}`);
    }
  }
}

function describe(at: StepLocation) {
  return at.sliceId ? `${at.sliceStatus} slice ${at.sliceId}` : at.phase;
}

function seconds(durationMs: number) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}
