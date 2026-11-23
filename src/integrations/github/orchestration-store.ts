import { Result } from 'better-result';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Logger } from 'pino';

import { messageOf } from '../../adapters/exception-details.js';
import { RemoteRef } from '../../adapters/git/remote-ref.js';
import { retryResult } from '../../adapters/retry.js';
import { reportCleanup } from '../../app/report-cleanup.js';
import { type GitCommandFailed, type RemoteUnavailable } from '../../ports/git-failures.js';
import { type RunStateConflict } from '../../ports/run-state-failures.js';
import { OrchestrationStateInvalid, PublicationInProgress } from './errors.js';
import {
  claimPublication,
  emptyOrchestration,
  type Orchestration,
  orchestrationSchema,
  ownsPublication,
  type PublicationOwnership,
  releasePublication,
  renewPublication,
} from './orchestration-state.js';

/**
 * Runs `step` only while this job still owns the publication, renewing its lease first, so a job
 * whose lease another job took over stops before its next outward-facing effect.
 */
export type WhileOwned = <T, E>(
  step: () => Promise<Result<T, E>>,
) => Promise<Result<T, E | StoreFailure | PublicationInProgress>>;

export type StoreFailure =
  GitCommandFailed | RemoteUnavailable | RunStateConflict | OrchestrationStateInvalid;

export class OrchestrationStore {
  private readonly refs: RemoteRef;

  constructor(
    repoRoot: string,
    private readonly now: () => number = Date.now,
  ) {
    this.refs = new RemoteRef(repoRoot);
  }

  /**
   * Runs `use` as the only job publishing `key`, under a lease another job may take over once it
   * expires. `use` renews the lease through `whileOwned` before each effect, and the lease is
   * released however `use` ends, a throw included.
   */
  async withPublicationOwnership<T, E>(
    key: string,
    logger: Logger,
    use: (whileOwned: WhileOwned) => Promise<Result<T, E>>,
  ): Promise<Result<T, E | StoreFailure | PublicationInProgress>> {
    const token = randomUUID();
    const claimed = await this.update((state) =>
      claimPublication(state, key, this.leaseFor(token), this.now()),
    );
    if (claimed.isErr()) return Result.err(claimed.error);
    if (!ownsPublication(claimed.value, key, token))
      return Result.err(
        new PublicationInProgress({
          message: `Another job is publishing ${key}; run the command again once it finishes.`,
        }),
      );
    const whileOwned: WhileOwned = async (step) => {
      const renewed = await this.renew(key, token);
      return renewed.isErr() ? Result.err(renewed.error) : step();
    };
    let used: Result<T, E>;
    let released: Result<Orchestration, StoreFailure>;
    try {
      used = await use(whileOwned);
    } finally {
      released = await this.update((state) => releasePublication(state, key, token));
    }
    return reportCleanup(
      used,
      released.map(() => undefined),
      logger,
    );
  }

  private leaseFor(token: string): PublicationOwnership {
    return { token, expiresAt: this.now() + OWNERSHIP_LEASE_MS };
  }

  private async renew(
    key: string,
    token: string,
  ): Promise<Result<void, StoreFailure | PublicationInProgress>> {
    const renewed = await this.update((state) =>
      renewPublication(state, key, this.leaseFor(token)),
    );
    if (renewed.isErr()) return Result.err(renewed.error);
    if (ownsPublication(renewed.value, key, token)) return Result.ok();
    return Result.err(
      new PublicationInProgress({
        message: `Another job took over publishing ${key} after this job's lease expired; this job stopped publishing.`,
      }),
    );
  }

  read(): Promise<Result<Orchestration, StoreFailure>> {
    return this.load().then((result) => result.map(({ state }) => state));
  }

  private load(): Promise<Result<{ state: Orchestration; expected?: string }, StoreFailure>> {
    return Result.gen(async function* (this: OrchestrationStore) {
      const listed = yield* Result.await(this.refs.list([ORCHESTRATION_REF]));
      if (!listed.has(ORCHESTRATION_REF)) return Result.ok({ state: emptyOrchestration() });
      yield* Result.await(this.refs.fetch([`+${ORCHESTRATION_REF}:${ORCHESTRATION_REF}`]));
      const expected = await this.refs.revision(ORCHESTRATION_REF);
      const contents = yield* Result.await(
        this.refs.required(['show', `${expected}:${ORCHESTRATION_FILE}`]),
      );
      const state = yield* Result.try({
        try: () => orchestrationSchema.parse(JSON.parse(contents)),
        catch: (cause) =>
          new OrchestrationStateInvalid({
            message: `Invalid GitHub orchestration state: ${messageOf(cause)}`,
          }),
      });
      return Result.ok({ state, expected });
    }, this);
  }

  async update(
    decide: (state: Orchestration) => Orchestration,
  ): Promise<Result<Orchestration, StoreFailure>> {
    const result = await retryResult(() => this.updateOnce(decide), {
      retries: ORCHESTRATION_ATTEMPTS - 1,
      delayMs: 0,
      shouldRetry: (error) => error._tag === 'RunStateConflict',
    });
    return result.mapError((error) =>
      error._tag === 'RunStateConflict'
        ? new OrchestrationStateInvalid({
            message: `Competing jobs kept updating GitHub orchestration ref ${ORCHESTRATION_REF}; try again.`,
          })
        : error,
    );
  }

  private updateOnce(
    decide: (state: Orchestration) => Orchestration,
  ): Promise<Result<Orchestration, StoreFailure>> {
    return Result.gen(async function* (this: OrchestrationStore) {
      const { state, expected } = yield* Result.await(this.load());
      const next = decide(state);
      if (isDeepStrictEqual(next, state)) return Result.ok(state);
      const commit = yield* Result.await(
        this.refs.commitFile(
          ORCHESTRATION_REF,
          ORCHESTRATION_FILE,
          `${JSON.stringify(next, null, 2)}\n`,
          'jig github: update orchestration',
        ),
      );
      yield* Result.await(
        this.refs.pushLeased([{ ref: ORCHESTRATION_REF, source: commit, expected }]),
      );
      return Result.ok(next);
    }, this);
  }
}

/** How long a publication owner holds its lease unrenewed; a crashed job's lease lapses after this. */
export const OWNERSHIP_LEASE_MS = 15 * 60 * 1000;

/** A hidden ref outside the branch list shares orchestration across every repository job. */
const ORCHESTRATION_REF = 'refs/jig/_orchestration';

/** Every repository job reads the shared receipts from this file in the hidden ref. */
const ORCHESTRATION_FILE = 'orchestration.json';

/** Competing jobs re-read the winner's state, within a bounded contention budget. */
const ORCHESTRATION_ATTEMPTS = 5;
