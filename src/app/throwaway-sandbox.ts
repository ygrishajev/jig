import type { AwilixContainer } from 'awilix';
import { Result } from 'better-result';
import { randomBytes } from 'node:crypto';

import { getCurrentBranch } from '../adapters/git/branch.js';
import { discardBranch, discardBranchOnExit } from '../adapters/git/throwaway-branch.js';
import type { SessionOpenFailure } from '../adapters/sandcastle/sandcastle-session.js';
import { runIdSchema } from '../domain/run-id.js';
import { runBranchFor, type RunIdentity } from '../domain/run-state.js';
import { LoggingObserver } from '../observers/logging-observer.js';
import type { GitCommandFailed, RepositoryInvalid } from '../ports/git-failures.js';
import type { RunSession, SessionCloseFailure } from '../ports/run-session.js';
import type { AppCradle } from './container.js';
import { type Lifetime, releaseInOrder, withResource } from './lifecycle.js';
import { observedEvents } from './observed-events.js';

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

/** The sandbox closes before its branch is removed; both are attempted however `use` ends. */
function useThrowawaySandbox<T, E>(
  app: AwilixContainer<AppCradle>,
  run: RunIdentity,
  setupCommand: string | null,
  use: (session: RunSession) => Promise<Result<T, E>>,
): Promise<Result<T, E | SessionOpenFailure | SessionCloseFailure | GitCommandFailed>> {
  const { repoRoot, logger, openSession } = app.cradle;
  const events = observedEvents(logger, [new LoggingObserver(logger)]);
  const sandbox: Lifetime<RunSession, SessionOpenFailure, SessionCloseFailure | GitCommandFailed> =
    {
      acquire: () => openSession({ run, events, setupCommand }),
      release: (session) =>
        releaseInOrder<SessionCloseFailure | GitCommandFailed>(
          [() => session.close(), () => discardBranch(repoRoot, runBranchFor(run.runId))],
          logger,
        ),
    };
  return withResource(sandbox, logger, use);
}
