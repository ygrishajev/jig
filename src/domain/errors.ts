/**
 * How the engine reacts to a failure: try the step again, send the work back to the agent,
 * stop and wait for a person, or abort the run.
 */
export type FailureKind = 'retry' | 'feedback' | 'block' | 'fatal';

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

export class AgentOutputInvalid extends SdlcError {
  readonly kind = 'feedback';
}

export class MergeFailed extends SdlcError {
  readonly kind = 'block';
}

export class ConfigInvalid extends SdlcError {
  readonly kind = 'fatal';
}
