import { Result } from 'better-result';
import { isDeepStrictEqual } from 'node:util';

import {
  emptyOrchestration,
  type Orchestration,
  orchestrationSchema,
} from '../../domain/github-orchestration.js';
import { messageOf } from '../../failures/messages.js';
import { retryResult } from '../../failures/retry.js';
import {
  OrchestrationStateInvalid,
  type PublicationReceipts,
  type ReceiptsFailure,
} from '../../ports/publication-receipts.js';
import { RemoteRef } from './remote-ref.js';

/** Keeps the shared orchestration in a hidden ref on `origin`, saved with a leased push. */
export class RemotePublicationReceipts implements PublicationReceipts {
  private readonly refs: RemoteRef;

  constructor(repoRoot: string) {
    this.refs = new RemoteRef(repoRoot);
  }

  read(): Promise<Result<Orchestration, ReceiptsFailure>> {
    return this.load().then((result) => result.map(({ state }) => state));
  }

  private load(): Promise<Result<{ state: Orchestration; expected?: string }, ReceiptsFailure>> {
    return Result.gen(async function* (this: RemotePublicationReceipts) {
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
  ): Promise<Result<Orchestration, ReceiptsFailure>> {
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
  ): Promise<Result<Orchestration, ReceiptsFailure>> {
    return Result.gen(async function* (this: RemotePublicationReceipts) {
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
