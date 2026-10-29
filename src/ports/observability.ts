import type { RunEvent } from '../domain/events.js';

export interface EventSink {
  publish(event: RunEvent): void;
}

export interface Clock {
  now(): number;
}
