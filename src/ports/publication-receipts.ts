import { type Result, TaggedError } from 'better-result';

import type { Orchestration } from '../domain/orchestration.js';
import type { GitCommandFailed, RemoteUnavailable } from './git-failures.js';
import type { RunStateConflict } from './run-state-failures.js';

/** The receipts every repository job shares: accepted requests, published PRs and comments. */
export interface ReceiptStore {
  read(): Promise<Result<Orchestration, ReceiptStoreFailure>>;
  /** Applies `decide` to the latest shared state, re-reading it when another job wrote first. */
  update(
    decide: (state: Orchestration) => Orchestration,
  ): Promise<Result<Orchestration, ReceiptStoreFailure>>;
}

export type ReceiptStoreFailure =
  GitCommandFailed | RemoteUnavailable | RunStateConflict | OrchestrationStateInvalid;

/**
 * The shared leases that keep two jobs from publishing the same request. Another job may take a
 * lease over once it expires; `claim` and `renew` say whether this job holds it afterwards.
 */
export interface PublicationOwnership {
  /** Takes the lease on `key`, or returns `undefined` while another job holds an unexpired one. */
  claim(key: string): Promise<Result<HeldPublication | undefined, ReceiptStoreFailure>>;
  /** Extends a held lease; `false` once another job has taken it over. */
  renew(held: HeldPublication): Promise<Result<boolean, ReceiptStoreFailure>>;
  release(held: HeldPublication): Promise<Result<void, ReceiptStoreFailure>>;
}

/** The lease one job holds on publishing an accepted request. */
export interface HeldPublication {
  key: string;
  token: string;
}

export class OrchestrationStateInvalid extends TaggedError('OrchestrationStateInvalid')<{
  message: string;
}> {}

/** Another job holds the lease to publish the same accepted request. */
export class PublicationInProgress extends TaggedError('PublicationInProgress')<{
  message: string;
}> {}
