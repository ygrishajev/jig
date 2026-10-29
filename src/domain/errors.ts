/**
 * How the engine reacts to a failure: try the step again, stop and wait for a person, or abort
 * the run. A failure is always the failing step's own; it never becomes work for another role.
 */
export type FailureKind = 'retry' | 'block' | 'fatal';

export abstract class SdlcError extends Error {
  abstract readonly kind: FailureKind;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AgentRunFailed extends SdlcError {
  readonly kind = 'retry';
}

/** The agent's own reply was malformed; a fresh attempt at the same step may well get it right. */
export class AgentOutputInvalid extends SdlcError {
  readonly kind = 'retry';
}

/** A fetch or push to the remote failed; the network may well be back on the next attempt. */
export class RemoteUnavailable extends SdlcError {
  readonly kind = 'retry';
}

export class MergeFailed extends SdlcError {
  readonly kind = 'block';
}

export class ConfigInvalid extends SdlcError {
  readonly kind = 'fatal';
}

export class RunRequestInvalid extends SdlcError {
  readonly kind = 'fatal';
}
