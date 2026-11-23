import { Result } from 'better-result';

import {
  completionReuseInPlay,
  completionReuseWasAuthorized,
  completionStillReusable,
} from '../domain/completion-reuse.js';
import type { Outcome } from '../domain/outcome.js';
import type { RunStep, RunStepContext } from '../flow/define-flow.js';
import type { SandboxUnavailable } from '../ports/agent-session.js';
import type { GitCommandFailed } from '../ports/git-failures.js';

type ObservationFailure = GitCommandFailed | SandboxUnavailable;

/**
 * Decides, once every slice is approved, whether the run finishes on the evidence its combined
 * review recorded or goes through an ordinary final check. It runs no command and asks no agent.
 */
export const decideCompletionReuse: RunStep<'checkingReuse'> = (context) =>
  Result.gen(async function* () {
    const reusable = yield* Result.await(evidenceStillHolds(context));
    return Result.ok<Outcome>({ type: reusable ? 'completionReused' : 'completionDeclined' });
  });

/** Observes the work as it stands now and asks the domain whether the recorded evidence still vouches for it. */
function evidenceStillHolds({
  state,
  ports,
  settings,
}: RunStepContext): Promise<Result<boolean, ObservationFailure>> {
  if (!completionReuseInPlay(state, settings)) return Promise.resolve(Result.ok(false));
  return Result.gen(async function* () {
    const observed = yield* Result.await(ports.workspace.collectFacts());
    const forkPoint = yield* Result.await(ports.workspace.forkPoint());
    return Result.ok(completionStillReusable(state, observed, settings, forkPoint));
  });
}

/**
 * Whether finishing must stop acting on reused evidence: the run was authorized to finish on it
 * and the work, sources or settings no longer match it. A run finishing otherwise is never
 * invalidated, and nothing is observed for it.
 */
export function completionInvalidated(
  context: RunStepContext,
): Promise<Result<boolean, ObservationFailure>> {
  return Result.gen(async function* () {
    if (!completionReuseWasAuthorized(context.state)) return Result.ok(false);
    return Result.ok(!(yield* Result.await(evidenceStillHolds(context))));
  });
}
