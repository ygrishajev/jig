import { type Result, TaggedError } from 'better-result';

import type { Orchestration } from '../domain/github-orchestration.js';
import type { GitCommandFailed, RemoteUnavailable } from './git-failures.js';
import type { RunStateConflict } from './run-state-failures.js';

/**
 * The orchestration every job publishing to the same repository shares: accepted requests,
 * publication receipts, refusals and publication leases.
 */
export interface PublicationReceipts {
  read(): Promise<Result<Orchestration, ReceiptsFailure>>;
  /**
   * Applies `decide` to the latest shared state and saves the result atomically, re-reading and
   * deciding again when another job saved first. An unchanged result saves nothing.
   */
  update(
    decide: (state: Orchestration) => Orchestration,
  ): Promise<Result<Orchestration, ReceiptsFailure>>;
}

export type ReceiptsFailure =
  GitCommandFailed | RemoteUnavailable | RunStateConflict | OrchestrationStateInvalid;

/**
 * Runs `step` only while this job still owns the publication, renewing its lease first, so a job
 * whose lease another job took over stops before its next outward-facing effect.
 */
export type WhileOwned = <T, E>(
  step: () => Promise<Result<T, E>>,
) => Promise<Result<T, E | ReceiptsFailure | PublicationInProgress>>;

/** The shared orchestration does not parse, or competing jobs kept it from being saved. */
export class OrchestrationStateInvalid extends TaggedError('OrchestrationStateInvalid')<{
  message: string;
}> {}

/** Another job holds the lease to publish the same accepted request. */
export class PublicationInProgress extends TaggedError('PublicationInProgress')<{
  message: string;
}> {}
