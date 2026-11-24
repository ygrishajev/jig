import { Result } from 'better-result';
import { randomBytes } from 'node:crypto';

import { runIdSchema } from '../domain/run-id.js';
import { runBranchFor, type RunIdentity } from '../domain/run-state.js';
import type { GitCommandFailed, RepositoryInvalid } from '../ports/git-failures.js';
import type { WarningLog } from '../ports/observability.js';
import type { RunSession, SessionCloseFailure } from '../ports/run-session.js';
import { type Lifetime, releaseInOrder, withResource } from './lifecycle.js';
import type { SandboxOpenFailure } from './sandbox-runtime.js';

/** What a one-off sandbox is opened, and its branch removed, with. */
export interface ThrowawaySandboxes {
  readonly log: WarningLog;
  currentBranch(): Promise<Result<string, RepositoryInvalid | GitCommandFailed>>;
  /** Opens a sandbox for `run`; `null` starts it without a setup command. */
  open(
    run: RunIdentity,
    setupCommand: string | null,
  ): Promise<Result<RunSession, SandboxOpenFailure>>;
  discardBranch(branch: string): Promise<Result<void, GitCommandFailed>>;
  /** Runs `use`, removing `branch` if the process exits before `use` finishes. */
  discardBranchOnExit<T>(branch: string, use: () => Promise<T>): Promise<T>;
}

/** Why a throwaway sandbox gave no answer: the branch it starts from, Docker, or its own cleanup. */
export type ThrowawaySandboxFailure =
  SandboxOpenFailure | SessionCloseFailure | GitCommandFailed | RepositoryInvalid;

/**
 * A sandbox for a one-off check, on a branch of its own that is removed afterwards, even when the
 * process is interrupted. It is never retried: a setup command that fails is the answer the
 * caller is waiting for, not a hiccup.
 */
export async function withThrowawaySandbox<T, E>(
  sandboxes: ThrowawaySandboxes,
  setupCommand: string | null,
  use: (session: RunSession) => Promise<Result<T, E>>,
): Promise<Result<T, E | ThrowawaySandboxFailure>> {
  const baseBranch = await sandboxes.currentBranch();
  if (baseBranch.isErr()) return Result.err(baseBranch.error);
  const run: RunIdentity = {
    runId: runIdSchema.parse(`init-${randomBytes(3).toString('hex')}`),
    baseBranch: baseBranch.value,
  };
  return sandboxes.discardBranchOnExit(runBranchFor(run.runId), () =>
    useThrowawaySandbox(sandboxes, run, setupCommand, use),
  );
}

/** The sandbox closes before its branch is removed; both are attempted however `use` ends. */
function useThrowawaySandbox<T, E>(
  sandboxes: ThrowawaySandboxes,
  run: RunIdentity,
  setupCommand: string | null,
  use: (session: RunSession) => Promise<Result<T, E>>,
): Promise<Result<T, E | SandboxOpenFailure | SessionCloseFailure | GitCommandFailed>> {
  const sandbox: Lifetime<RunSession, SandboxOpenFailure, SessionCloseFailure | GitCommandFailed> =
    {
      acquire: () => sandboxes.open(run, setupCommand),
      release: (session) =>
        releaseInOrder<SessionCloseFailure | GitCommandFailed>(
          [() => session.close(), () => sandboxes.discardBranch(runBranchFor(run.runId))],
          sandboxes.log,
        ),
    };
  return withResource(sandbox, sandboxes.log, use);
}
