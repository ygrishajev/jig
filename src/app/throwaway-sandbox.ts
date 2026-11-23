import type { AwilixContainer } from 'awilix';
import { Result } from 'better-result';
import { randomBytes } from 'node:crypto';

import { getCurrentBranch } from '../adapters/git/branch.js';
import { discardBranch, discardBranchOnExit } from '../adapters/git/throwaway-branch.js';
import type {
  SessionCloseFailure,
  SessionOpenFailure,
} from '../adapters/sandcastle/sandcastle-session.js';
import { runIdSchema } from '../domain/run-id.js';
import { runBranchFor, type RunIdentity } from '../domain/run-state.js';
import { LoggingObserver } from '../observers/logging-observer.js';
import type { GitCommandFailed, RepositoryInvalid } from '../ports/git-failures.js';
import type { AppCradle, RunSession } from './container.js';
import { observedEvents } from './observed-events.js';
import { reportCleanup } from './report-cleanup.js';

/**
 * A sandbox for a one-off check, on a branch of its own that is removed afterwards, even when the
 * process is interrupted; its events are logged to the console. It is never retried: a setup command that fails is the answer the
 * caller is waiting for, not a hiccup.
 */
export async function withThrowawaySandbox<T, E>(
  app: AwilixContainer<AppCradle>,
  setupCommand: string | null,
  use: (session: RunSession) => Promise<Result<T, E>>,
): Promise<
  Result<T, E | SessionOpenFailure | SessionCloseFailure | GitCommandFailed | RepositoryInvalid>
> {
  const { repoRoot } = app.cradle;
  const baseBranch = await getCurrentBranch(repoRoot);
  if (baseBranch.isErr()) return Result.err(baseBranch.error);
  const run: RunIdentity = {
    runId: runIdSchema.parse(`init-${randomBytes(3).toString('hex')}`),
    baseBranch: baseBranch.value,
  };
  return discardBranchOnExit(repoRoot, runBranchFor(run.runId), () =>
    useThrowawaySandbox(app, run, setupCommand, use),
  );
}

async function useThrowawaySandbox<T, E>(
  app: AwilixContainer<AppCradle>,
  run: RunIdentity,
  setupCommand: string | null,
  use: (session: RunSession) => Promise<Result<T, E>>,
): Promise<Result<T, E | SessionOpenFailure | SessionCloseFailure | GitCommandFailed>> {
  const { repoRoot, logger, openSession } = app.cradle;
  const events = observedEvents(logger, [new LoggingObserver(logger)]);
  const session = await openSession({ run, events, setupCommand });
  if (session.isErr()) return Result.err(session.error);
  let used: Result<T, E>;
  let closed: Result<void, SessionCloseFailure>;
  let discarded: Result<void, GitCommandFailed>;
  try {
    used = await use(session.value);
  } finally {
    closed = await session.value.close();
    discarded = await discardBranch(repoRoot, runBranchFor(run.runId));
  }
  if (closed.isErr() && discarded.isErr()) {
    logger.warn({ err: discarded.error }, 'removing the throwaway branch failed as well');
  }
  const cleaned: Result<void, SessionCloseFailure | GitCommandFailed> = closed.isErr()
    ? closed
    : discarded;
  return reportCleanup(used, cleaned, logger);
}
