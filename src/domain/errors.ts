import { Panic, type Result, TaggedError } from 'better-result';

/**
 * How the engine reacts to a failure: try the step again, stop and wait for a person, or abort
 * the run. A failure is always the failing step's own; it never becomes work for another role.
 */
export type FailureKind = 'retry' | 'block' | 'fatal';

export type JigError =
  | AgentRunFailed
  | AgentOutputInvalid
  | RemoteUnavailable
  | SandboxUnavailable
  | SetupCommandFailed
  | RunStateConflict
  | MergeFailed
  | GitCommandFailed
  | ConfigInvalid
  | RunRequestInvalid
  | RunInProgress
  | MetricsLogCorrupt
  | LocalStateUnwritable
  | ImageBuildFailed;

/** JavaScript can throw anything, not only an `Error`. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What was first thrown under a chain of panics, such as the one `Result.gen` wraps around a throw. */
export function rootCause(error: unknown): unknown {
  let cause = error;
  while (Panic.is(cause) && cause.cause !== undefined) cause = cause.cause;
  return cause;
}

/** A failure worth another attempt: a step, or a sandbox that did not start, gets bounded retries. */
export function isTransient(error: JigError): boolean {
  return error.kind === 'retry';
}

export function isJigError(value: unknown): value is JigError {
  return jigErrorClasses.some((errorClass) => value instanceof errorClass);
}

export class AgentRunFailed extends TaggedError('AgentRunFailed')<{ message: string }> {
  readonly kind = 'retry' as const;
}

/** The agent's own reply was malformed; a fresh attempt at the same step may well get it right. */
export class AgentOutputInvalid extends TaggedError('AgentOutputInvalid')<{ message: string }> {
  readonly kind = 'retry' as const;
}

/** A fetch or push to the remote failed; the network may well be back on the next attempt. */
export class RemoteUnavailable extends TaggedError('RemoteUnavailable')<{ message: string }> {
  readonly kind = 'retry' as const;
}

/**
 * The sandbox did not start: the Docker daemon, a container start, or creating the worktree
 * failed in a way sandcastle does not tell apart from a passing hiccup, so it is worth another go.
 */
export class SandboxUnavailable extends TaggedError('SandboxUnavailable')<{ message: string }> {
  readonly kind = 'retry' as const;
}

/**
 * The setup command exited non-zero or outlived its timeout. It is the project's toolchain, so
 * `init` hands it back to the planner; in a run it is retried, since `npm ci` fails on a network
 * blip as readily as on a broken lockfile.
 */
export class SetupCommandFailed extends TaggedError('SetupCommandFailed')<{
  message: string;
  output: string;
}> {
  readonly kind = 'retry' as const;
}

/** The remote copy of a run moved in a way this process cannot follow without losing someone's work. */
export class RunStateConflict extends TaggedError('RunStateConflict')<{ message: string }> {
  readonly kind = 'block' as const;
}

export class MergeFailed extends TaggedError('MergeFailed')<{ message: string }> {
  readonly kind = 'block' as const;
}

/** A git command failed for a reason the operator has to look at: a missing ref, a broken repository. */
export class GitCommandFailed extends TaggedError('GitCommandFailed')<{
  message: string;
  command: string;
  stderr: string;
}> {
  readonly kind = 'block' as const;
}

export class ConfigInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

export class RunRequestInvalid extends TaggedError('RunRequestInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

/** Another jig process is already running this run; two writers would overwrite each other. */
export class RunInProgress extends TaggedError('RunInProgress')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

/** A complete line of a run's metrics log is not a metric record: the file was edited or damaged. */
export class MetricsLogCorrupt extends TaggedError('MetricsLogCorrupt')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

/** Reading or writing under `.jig/` failed: a full disk, a permission, a file that is not there. */
export class LocalStateUnwritable extends TaggedError('LocalStateUnwritable')<{
  message: string;
  path: string;
}> {
  readonly kind = 'fatal' as const;
}

/** A sandbox image could not be built, or docker could not be asked about one; `output` is what docker said. */
export class ImageBuildFailed extends TaggedError('ImageBuildFailed')<{
  message: string;
  output: string;
}> {
  readonly kind = 'fatal' as const;
}

const jigErrorClasses = [
  AgentRunFailed,
  AgentOutputInvalid,
  RemoteUnavailable,
  SandboxUnavailable,
  SetupCommandFailed,
  RunStateConflict,
  MergeFailed,
  GitCommandFailed,
  ConfigInvalid,
  RunRequestInvalid,
  RunInProgress,
  MetricsLogCorrupt,
  LocalStateUnwritable,
  ImageBuildFailed,
];

/** Transitional: returns the value or throws the error; Task 11 deletes it. */
export function orThrow<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}
