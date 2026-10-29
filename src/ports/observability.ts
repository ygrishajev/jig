import type { RunEvent } from '../domain/events.js';

export interface EventSink {
  emit(event: RunEvent): void;
}

export interface Clock {
  now(): number;
}
