import { Result } from 'better-result';
import { isDeepStrictEqual } from 'node:util';

import { RemoteRef } from '../../adapters/git/remote-ref.js';
import {
  type GitCommandFailed,
  messageOf,
  type RemoteUnavailable,
  type RunStateConflict,
} from '../../domain/errors.js';
import { retryResult } from '../../domain/retry.js';
import { OrchestrationStateInvalid } from './errors.js';
import {
  emptyOrchestration,
  type Orchestration,
  orchestrationSchema,
} from './orchestration-state.js';

type StoreFailure =
  GitCommandFailed | RemoteUnavailable | RunStateConflict | OrchestrationStateInvalid;

export class OrchestrationStore {
  private readonly refs: RemoteRef;

  constructor(repoRoot: string) {
    this.refs = new RemoteRef(repoRoot);
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

  update(
    decide: (state: Orchestration) => Orchestration,
  ): Promise<Result<Orchestration, StoreFailure>> {
    return retryResult(() => this.updateOnce(decide), {
      retries: ORCHESTRATION_ATTEMPTS - 1,
      delayMs: 0,
      shouldRetry: (error) => error._tag === 'RunStateConflict',
    });
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
const ORCHESTRATION_REF = 'refs/jig/_orchestration';
const ORCHESTRATION_FILE = 'orchestration.json';

/** Competing jobs re-read the winner's state, within a bounded contention budget. */
const ORCHESTRATION_ATTEMPTS = 5;
