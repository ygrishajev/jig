import { Result } from 'better-result';

import type { RunIdentity } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import { retryResult } from '../failures/retry.js';
import type { EngineDependencies } from '../flow/engine.js';
import { transientRetryPolicy } from '../flow/retry-policy.js';
import type { Clock, EventSink, RunTelemetry, WarningLog } from '../ports/observability.js';
import type { RunSession } from '../ports/run-session.js';
import type { RunStore } from '../ports/run-store.js';
import type { Workspace } from '../ports/workspace.js';
import { type Release, releasingOnPanic } from './lifecycle.js';
import type { RunScope } from './run-jig.js';
import type { SandboxOpenFailure } from './sandbox-runtime.js';

/**
 * What a run's scope is built from. Nothing is built until the scope opens, and every part is
 * built again for each run, so two runs never share events, metrics or a workspace.
 */
export interface RunScopeParts {
  readonly settings: RunSettings;
  readonly clock: Clock;
  /** Where a release that fails after a panic is reported. */
  readonly log: WarningLog;
  /** The run's events, heard by its observers and by `telemetry`'s, and its own log. */
  reportingFor(run: RunIdentity, telemetry: RunTelemetry | undefined): RunReporting;
  openSession(run: RunIdentity, events: EventSink): Promise<Result<RunSession, SandboxOpenFailure>>;
  workspaceFor(run: RunIdentity, session: RunSession): Workspace;
}

/** Where one run reports what happens in it, until it is disposed. */
export interface RunReporting {
  readonly events: EventSink;
  readonly log: SandboxStartLog;
  /** Stops the run's observers hearing its events. */
  dispose(): Promise<void>;
}

export interface SandboxStartLog {
  warn(details: { err: unknown; attempt: number }, message: string): void;
}

/**
 * Opens the run's sandbox and hands back what its engine works with. A sandbox that fails to
 * start, or a panic while building the scope, leaves nothing behind: the sandbox opened so far
 * is closed before the run's reporting is disposed.
 */
export async function acquireRunScope(
  parts: RunScopeParts,
  { runId, baseBranch }: RunIdentity,
  store: RunStore,
  telemetry: RunTelemetry | undefined,
): Promise<Result<RunScope, SandboxOpenFailure>> {
  const run: RunIdentity = { runId, baseBranch };
  const reporting = parts.reportingFor(run, telemetry);
  const disposeReporting: Release<never> = async () => {
    await reporting.dispose();
    return Result.ok();
  };
  const opened = await releasingOnPanic(
    () => openSessionRetrying(parts, run, reporting),
    [disposeReporting],
    parts.log,
  );
  if (opened.isErr()) {
    await reporting.dispose();
    return Result.err(opened.error);
  }
  const session = opened.value;
  return releasingOnPanic(
    async () => Result.ok(scopeOver(parts, { run, store, reporting, session })),
    [() => session.close(), disposeReporting],
    parts.log,
  );
}

/**
 * A sandbox that failed to start for a reason that may pass — Docker, the network under the
 * setup command — gets the same bounded retries as a step; a configuration problem does not.
 */
function openSessionRetrying(
  parts: RunScopeParts,
  run: RunIdentity,
  reporting: RunReporting,
): Promise<Result<RunSession, SandboxOpenFailure>> {
  return retryResult<RunSession, SandboxOpenFailure>(
    () => parts.openSession(run, reporting.events),
    {
      ...transientRetryPolicy(parts.settings),
      onFailedAttempt: ({ error, attempt }) =>
        reporting.log.warn({ err: error, attempt }, 'the sandbox did not start'),
    },
  );
}

function scopeOver(
  parts: RunScopeParts,
  {
    run,
    store,
    reporting,
    session,
  }: { run: RunIdentity; store: RunStore; reporting: RunReporting; session: RunSession },
): RunScope {
  const engineDependencies: EngineDependencies = {
    ports: { agent: session, workspace: parts.workspaceFor(run, session) },
    store,
    events: reporting.events,
    clock: parts.clock,
    settings: parts.settings,
  };
  return {
    engineDependencies,
    closeSession: () => session.close(),
    dispose: () => reporting.dispose(),
  };
}
