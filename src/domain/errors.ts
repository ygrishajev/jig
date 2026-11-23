import { TaggedError } from 'better-result';

/**
 * How the engine reacts to a failure: try the step again, stop and wait for a person, or abort
 * the run. A failure is always the failing step's own; it never becomes work for another role.
 */
export type FailureKind = 'retry' | 'block' | 'fatal';

export type JigError =
  | AgentRunFailed
  | AgentOutputInvalid
  | PlanNotCovered
  | DesignUnresolved
  | RemoteUnavailable
  | SandboxUnavailable
  | SetupCommandFailed
  | RunStateConflict
  | RunCodeUnavailable
  | MergeFailed
  | GitCommandFailed
  | CommitImportRefused
  | CommitRejected
  | ConfigInvalid
  | RunRequestInvalid
  | RunInProgress
  | MetricsLogCorrupt
  | LocalStateUnwritable
  | CodexLoginNotSaved
  | ImageBuildFailed
  | CommandInputInvalid;

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

/**
 * The planner's slices do not cover its plan. Distinct from AgentOutputInvalid so the slicing
 * step can retry exactly this failure once, with the check's diagnostics as correction feedback.
 */
export class PlanNotCovered extends TaggedError('PlanNotCovered')<{ message: string }> {
  readonly kind = 'retry' as const;
}

/**
 * The design still carries consequential findings after the planner's one revision and its
 * re-review. Only the operator can settle them, so the run stops before any slice is written.
 */
export class DesignUnresolved extends TaggedError('DesignUnresolved')<{
  message: string;
  findingIds: string[];
}> {
  readonly kind = 'block' as const;
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

/**
 * A saved run names a code checkpoint this machine cannot produce: the commit is neither kept here
 * nor published on the remote, so resuming would continue from code the state does not describe.
 */
export class RunCodeUnavailable extends TaggedError('RunCodeUnavailable')<{ message: string }> {
  readonly kind = 'block' as const;
}

export class MergeFailed extends TaggedError('MergeFailed')<{ message: string }> {
  readonly kind = 'block' as const;
}

/**
 * A git command failed for a reason the operator has to look at: a missing ref, a broken
 * repository. `command` is what was run; `output` is what it printed, or why it could not run.
 */
export class GitCommandFailed extends TaggedError('GitCommandFailed')<{
  message: string;
  command: string;
  output: string;
}> {
  readonly kind = 'block' as const;
}

/** The sandbox's commits were not taken: its answers did not add up, or it rewrote approved work. */
export class CommitImportRefused extends TaggedError('CommitImportRefused')<{ message: string }> {
  readonly kind = 'block' as const;
}

/** The target repository's commit hooks refused the commit; `output` is what they printed. */
export class CommitRejected extends TaggedError('CommitRejected')<{
  message: string;
  output: string;
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

/**
 * Reading or writing jig's own files on this machine failed, under `.jig/` or in a temporary
 * directory: a full disk, a permission, a file that is not there.
 */
export class LocalStateUnwritable extends TaggedError('LocalStateUnwritable')<{
  message: string;
  path: string;
}> {
  readonly kind = 'fatal' as const;
}

/**
 * The Codex login a run refreshed could not be handed back to the operator's own login, or its
 * lock could not be let go; the run's work is unaffected.
 */
export class CodexLoginNotSaved extends TaggedError('CodexLoginNotSaved')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

/** A sandbox image could not be built, or docker could not be asked about one; `output` is what docker said. */
export class ImageBuildFailed extends TaggedError('ImageBuildFailed')<{
  message: string;
  output: string;
}> {
  readonly kind = 'fatal' as const;
}

/** What the operator typed does not fit the command. */
export class CommandInputInvalid extends TaggedError('CommandInputInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

const jigErrorClasses = [
  AgentRunFailed,
  AgentOutputInvalid,
  PlanNotCovered,
  DesignUnresolved,
  RemoteUnavailable,
  SandboxUnavailable,
  SetupCommandFailed,
  RunStateConflict,
  RunCodeUnavailable,
  MergeFailed,
  GitCommandFailed,
  CommitImportRefused,
  CommitRejected,
  ConfigInvalid,
  RunRequestInvalid,
  RunInProgress,
  MetricsLogCorrupt,
  LocalStateUnwritable,
  CodexLoginNotSaved,
  ImageBuildFailed,
  CommandInputInvalid,
];
