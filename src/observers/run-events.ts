import { isPanic, panic } from 'better-result';
import { EventEmitter } from 'node:events';

import type { RunEvent } from '../domain/events.js';
import type { EventSink } from '../ports/observability.js';

export type RunEventMap = { event: [RunEvent] };

export class RunEvents extends EventEmitter<RunEventMap> implements EventSink {
  publish(event: RunEvent): void {
    this.emit('event', event);
  }
}

/**
 * Subscribes an observer to every event. EventEmitter calls listeners synchronously, so a
 * throwing observer would otherwise abort the run that published the event. A `Panic` is a bug,
 * and still does.
 */
export function observe(
  events: RunEvents,
  handle: (event: RunEvent) => void,
  onObserverError: (error: unknown) => void,
): void {
  events.on('event', (event) => {
    try {
      handle(event);
    } catch (error) {
      if (isPanic(error)) panic(error.message, error);
      onObserverError(error);
    }
  });
}
