/**
 * How the engine reacts to a failure: try the step again, stop and wait for a person, or abort
 * the run. A failure is always the failing step's own; it never becomes work for another role.
 */
export type FailureKind = 'retry' | 'block' | 'fatal';

/** JavaScript can throw anything, not only an `Error`. */
export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * The sandbox did not start: the Docker daemon, a container start, or creating the worktree
 * failed in a way sandcastle does not tell apart from a passing hiccup, so it is worth another go.
 */
export class SandboxUnavailable extends SdlcError {
  readonly kind = 'retry';
}

/**
 * The setup command exited non-zero or outlived its timeout. It is the project's toolchain, so
 * `init` hands it back to the planner; in a run it is retried, since `npm ci` fails on a network
 * blip as readily as on a broken lockfile.
 */
export class SetupCommandFailed extends SdlcError {
  readonly kind = 'retry';

  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
  }
}

/** The remote copy of a run moved in a way this process cannot follow without losing someone's work. */
export class RunStateConflict extends SdlcError {
  readonly kind = 'block';
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

/** Another sdlc process is already running this run; two writers would overwrite each other. */
export class RunInProgress extends SdlcError {
  readonly kind = 'fatal';
}

/** A complete line of a run's metrics log is not a metric record: the file was edited or damaged. */
export class MetricsLogCorrupt extends SdlcError {
  readonly kind = 'fatal';
}
