import { Result } from 'better-result';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  claimPublication,
  emptyOrchestration,
  type Orchestration,
  orchestrationSchema,
  ownsPublication,
  publicationLease,
  releasePublication,
  renewPublication,
} from '../../domain/orchestration.js';
import { messageOf } from '../../failures/messages.js';
import { retryResult } from '../../failures/retry.js';
import {
  type HeldPublication,
  OrchestrationStateInvalid,
  type PublicationOwnership,
  type ReceiptStore,
  type ReceiptStoreFailure,
} from '../../ports/publication-receipts.js';
import { RemoteRef } from './remote-ref.js';

/** Keeps the shared receipts and publication leases in one hidden ref on the remote. */
export class GitOrchestrationStore implements ReceiptStore, PublicationOwnership {
  private readonly refs: RemoteRef;

  constructor(
    repoRoot: string,
    private readonly now: () => number = Date.now,
  ) {
    this.refs = new RemoteRef(repoRoot);
  }

  async claim(key: string): Promise<Result<HeldPublication | undefined, ReceiptStoreFailure>> {
    const token = randomUUID();
    const claimed = await this.update((state) =>
      claimPublication(state, key, publicationLease(token, this.now()), this.now()),
    );
    return claimed.map((state) =>
      ownsPublication(state, key, token) ? { key, token } : undefined,
    );
  }

  async renew({ key, token }: HeldPublication): Promise<Result<boolean, ReceiptStoreFailure>> {
    const renewed = await this.update((state) =>
      renewPublication(state, key, publicationLease(token, this.now())),
    );
    return renewed.map((state) => ownsPublication(state, key, token));
  }

  async release({ key, token }: HeldPublication): Promise<Result<void, ReceiptStoreFailure>> {
    const released = await this.update((state) => releasePublication(state, key, token));
    return released.map(() => undefined);
  }

  read(): Promise<Result<Orchestration, ReceiptStoreFailure>> {
    return this.load().then((result) => result.map(({ state }) => state));
  }

  private load(): Promise<
    Result<{ state: Orchestration; expected?: string }, ReceiptStoreFailure>
  > {
    return Result.gen(async function* (this: GitOrchestrationStore) {
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
  ): Promise<Result<Orchestration, ReceiptStoreFailure>> {
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
  ): Promise<Result<Orchestration, ReceiptStoreFailure>> {
    return Result.gen(async function* (this: GitOrchestrationStore) {
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

/** A hidden ref outside the branch list shares orchestration across every repository job. */
const ORCHESTRATION_REF = 'refs/jig/_orchestration';

/** Every repository job reads the shared receipts from this file in the hidden ref. */
const ORCHESTRATION_FILE = 'orchestration.json';

/** Competing jobs re-read the winner's state, within a bounded contention budget. */
const ORCHESTRATION_ATTEMPTS = 5;
