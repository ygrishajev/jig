import { type Result, TaggedError } from 'better-result';

import type { RunId } from '../domain/run-id.js';
import type { RunState } from '../domain/run-state.js';
import type { GitCommandFailed, RemoteUnavailable, RepositoryInvalid } from './git-failures.js';
import type { RunStateConflict } from './run-state-failures.js';

/**
 * The operator's clone as issue publication sees it: the branch checked out, where a run branch
 * points, and the one guarded way a run's code is inspected and pushed. Inspection and publication
 * enforce the protected-path refusal themselves, so no caller can push past it.
 */
export interface RunBranches {
  checkedOutBranch(): Promise<Result<string, RepositoryInvalid | GitCommandFailed>>;
  /** The commit run `runId`'s local branch points at, or `undefined` without one. */
  head(runId: RunId): Promise<Result<string | undefined, GitCommandFailed>>;
  /**
   * Whether a stuck run committed anything past where it started. A run saved before its starting
   * commit was recorded has no known start, so it is never taken to have work.
   */
  hasWorkBeyondStart(checkpoint: CodeCheckpoint): Promise<Result<boolean, GitCommandFailed>>;
  /**
   * Inspects exactly `revision` against the default branch on origin. Receipt reuse must not
   * bypass this: a prior receipt does not prove that the run's code is safe to publish.
   */
  inspect(revision: InspectedRevision): Promise<Result<RunBranchInspection, RunBranchFailure>>;
  /**
   * The only way an issue run's code reaches the remote. Refuses a branch that moved off
   * `revision`, refuses a revision that changes a protected path, skips one that changes nothing
   * unless `pushUnchanged` asks for its commits anyway, and otherwise pushes that object ID as a
   * fast-forward under a lease on the remote branch. Any failure to inspect publishes nothing.
   */
  publish(
    revision: InspectedRevision & { pushUnchanged?: boolean },
  ): Promise<Result<RunBranchPublication, RunBranchFailure>>;
}

export type CodeCheckpoint = Pick<RunState, 'startingCommit' | 'codeRevision'>;

export interface InspectedRevision {
  runId: RunId;
  revision: string;
  defaultBranch: string;
}

export type RunBranchInspection =
  { kind: 'refused'; paths: string[] } | { kind: 'clean'; changesFiles: boolean };

export type RunBranchFailure =
  RunBranchUnpublishable | GitCommandFailed | RemoteUnavailable | RunStateConflict;

export type RunBranchPublication =
  | { kind: 'refused'; paths: string[] }
  | { kind: 'unchanged' }
  | { kind: 'published'; changesFiles: boolean };

/** The run branch could not be inspected, or moved away from what was inspected, so nothing was pushed. */
export class RunBranchUnpublishable extends TaggedError('RunBranchUnpublishable')<{
  message: string;
}> {}
