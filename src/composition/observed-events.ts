import type { Logger } from 'pino';

import type { RunEvent } from '../domain/events.js';
import { observe, RunEvents } from '../observers/run-events.js';

/** Events the given observers hear; one that fails is logged, and the others still hear the event. */
export function observedEvents(
  logger: Logger,
  observers: { handle(event: RunEvent): void }[],
): RunEvents {
  const events = new RunEvents();
  const onObserverError = (error: unknown): void =>
    logger.warn({ err: error }, 'an observer failed');
  for (const observer of observers) {
    observe(events, (event) => observer.handle(event), onObserverError);
  }
  return events;
}
