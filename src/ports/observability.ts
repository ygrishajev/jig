import type { RunEvent } from '../domain/events.js';

export interface EventSink {
  publish(event: RunEvent): void;
}

export interface Clock {
  now(): number;
}

/** Tracing for one invocation of a run: its observer hears the run's events until it is shut down. */
export interface RunTelemetry {
  readonly observer: RunEventObserver;
  /** Flushes what was recorded; called once the run's sandbox and scope are released. */
  shutdown(): Promise<void>;
}

export interface RunEventObserver {
  handle(event: RunEvent): void;
}

/** What an operation tells the operator while it works, besides the warnings `WarningLog` takes. */
export interface OperationLog extends WarningLog {
  warn(details: { err: unknown }, message: string): void;
  warn(message: string): void;
  info(details: object, message: string): void;
  info(message: string): void;
}

/** Where a failure that does not change an outcome, such as a failed cleanup, is reported. */
export interface WarningLog {
  warn(details: { err: unknown }, message: string): void;
}
