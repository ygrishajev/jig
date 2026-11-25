import { Result } from 'better-result';

import type { ConfigInvalid } from '../config/errors.js';
import { type JigConfig, validationWarnings } from '../config/load-config.js';
import { newRunId, type RunId } from '../domain/run-id.js';
import {
  type CodePublication,
  type RunIdentity,
  type RunState,
  startRun,
} from '../domain/run-state.js';
import { finalStatus } from '../flow/define-flow.js';
import {
  type EngineDependencies,
  type EngineFailure,
  type EngineResult,
  runEngine,
} from '../flow/engine.js';
import type {
  SandboxCredentialsInvalid,
  SandboxPreparationInvalid,
} from '../ports/agent-session.js';
import type { GitCommandFailed, RepositoryInvalid } from '../ports/git-failures.js';
import type { LocalStateUnwritable } from '../ports/local-state.js';
import type { RunTelemetry, WarningLog } from '../ports/observability.js';
import type { InvocationRecords } from '../ports/run-records.js';
import type { SessionCloseFailure } from '../ports/run-session.js';
import type { MetricsLogCorrupt, RunInProgress } from '../ports/run-state-failures.js';
import type {
  RunStore,
  RunStoreCatalog,
  RunStoreFailure,
  RunStoreSetupInvalid,
} from '../ports/run-store.js';
import type { ImageBuildFailed } from '../ports/sandbox-images.js';
import { RunRequestInvalid } from './errors.js';
import { invocationRecord } from './invocation-record.js';
import { type Lifetime, releaseInOrder, withResource } from './lifecycle.js';
import { runFlow } from './run-flow.js';
import { openRunStore } from './run-stores.js';
import type { SandboxOpenFailure } from './sandbox-runtime.js';

/**
 * Start a run from a request — named `runId`, or a fresh id — or resume the run `resume`.
 * Starting with the id of an existing run resumes it only when the text is the request it was
 * started with, so a retried CI job resumes safely and a new request is never attached to an old run.
 */
export type RunJigInput =
  { start: StartRequest; runId?: RunId; requiredStores?: readonly string[] } | { resume: RunId };

/** The text of a request and, when it came from one, the file it was read from. */
export type StartRequest = {
  text: string;
  file?: string;
  merge?: boolean;
  codePublication?: CodePublication;
};

export type RunReport = EngineResult;

/** Why `runJig` returned no report. */
export type RunJigFailure =
  | RunInProgress
  | LocalStateUnwritable
  | RunStoreSetupInvalid
  | StartFailure
  | AdvanceFailure
  | MetricsLogCorrupt;

type StartFailure = RunStoreFailure | RunRequestInvalid | RepositoryInvalid | GitCommandFailed;

type AdvanceFailure =
  | ConfigInvalid
  | SandboxCredentialsInvalid
  | SandboxPreparationInvalid
  | ImageBuildFailed
  | SandboxOpenFailure
  | SessionCloseFailure
  | EngineFailure;

/** What a run needs from the repository it runs in, its stores, this machine and the sandbox. */
export interface RunCapabilities {
  config: JigConfig;
  log: RunLog;
  /** Makes this process the run's only writer until the returned release is called. */
  lockRun(runId: RunId): Promise<Result<() => Promise<void>, RunInProgress | LocalStateUnwritable>>;
  runStores: RunStoreCatalog;
  /** The branch and exact commit a new run starts from. */
  startingPoint(): Promise<Result<StartingPoint, RepositoryInvalid | GitCommandFailed>>;
  records: InvocationRecords;
  sandbox: RunSandbox;
}

export interface RunLog extends WarningLog {
  warn(details: { err: unknown }, message: string): void;
  warn(message: string): void;
  info(details: object, message: string): void;
}

export interface StartingPoint {
  baseBranch: string;
  startingCommit: string | undefined;
}

/** What a run that has work left prepares before it starts the run's sandbox, and the sandbox itself. */
export interface RunSandbox {
  /** Refuses a step whose agent has no credentials, before anything is built or started. */
  checkCredentials(): Result<void, ConfigInvalid | SandboxCredentialsInvalid>;
  ensureImage(): Promise<
    Result<void, ConfigInvalid | SandboxPreparationInvalid | ImageBuildFailed>
  >;
  /** `undefined` when no telemetry is configured. */
  startTelemetry(): Promise<RunTelemetry | undefined>;
  /** Starts the run's sandbox, retrying a start that may pass; a failed start leaves nothing open. */
  openScope(
    run: RunIdentity,
    store: RunStore,
    telemetry: RunTelemetry | undefined,
  ): Promise<Result<RunScope, SandboxOpenFailure>>;
}

/** The run's open sandbox and everything built for it, released in the order `runJig` decides. */
export interface RunScope {
  readonly engineDependencies: EngineDependencies;
  closeSession(): Promise<Result<void, SessionCloseFailure>>;
  dispose(): Promise<void>;
}

/** The run to start or resume: its id, and the request text when one was given. */
type RunTarget = {
  runId: RunId;
  request?: string;
  merge?: boolean;
  codePublication?: CodePublication;
  requiredStores?: readonly string[];
};

/**
 * Runs `input` to its next stop. The whole run holds the run's lock, so a second
 * process for the same id fails with `RunInProgress` instead of writing over it, and the lock is
 * released last. A run that already ended is reported as it is, without touching the sandbox.
 */
export function runJig(
  capabilities: RunCapabilities,
  input: RunJigInput,
): Promise<Result<RunReport, RunJigFailure>> {
  const target = targetOf(input);
  return withResource(runLock(capabilities, target.runId), capabilities.log, () =>
    runLocked(capabilities, target),
  );
}

function targetOf(input: RunJigInput): RunTarget {
  if ('resume' in input) return { runId: input.resume };
  const { start } = input;
  return {
    requiredStores: input.requiredStores,
    request: start.text,
    merge: start.merge,
    codePublication: start.codePublication,
    runId: input.runId ?? newRunId(start),
  };
}

function runLock(
  { lockRun }: RunCapabilities,
  runId: RunId,
): Lifetime<() => Promise<void>, RunInProgress | LocalStateUnwritable, never> {
  return {
    acquire: () => lockRun(runId),
    release: async (unlock) => {
      await unlock();
      return Result.ok();
    },
  };
}

function runLocked(
  capabilities: RunCapabilities,
  target: RunTarget,
): Promise<Result<RunReport, RunJigFailure>> {
  return Result.gen(async function* () {
    const { config, log, runStores } = capabilities;
    const store = yield* Result.await(openRunStore(runStores, config, target.requiredStores));
    const state = yield* Result.await(startOrResume(capabilities, store, target));
    for (const warning of validationWarnings(config)) log.warn(warning);
    const finished = finalStatus(runFlow, state);
    const report = finished
      ? { state, status: finished }
      : yield* Result.await(advance(capabilities, store, state));
    yield* Result.await(recordInvocation(capabilities.records, report));
    return Result.ok(report);
  });
}

async function startOrResume(
  capabilities: RunCapabilities,
  store: RunStore,
  { runId, request, merge, codePublication }: RunTarget,
): Promise<Result<RunState, StartFailure>> {
  const existing = await store.load(runId);
  if (existing.isErr()) return Result.err(existing.error);
  if (request === undefined) {
    return existing.value
      ? Result.ok(existing.value)
      : Result.err(new RunRequestInvalid({ message: `No run found with id "${runId}".` }));
  }
  if (!existing.value)
    return startNewRun(capabilities, store, { runId, request, merge, codePublication });
  if (request !== existing.value.request) {
    return Result.err(
      new RunRequestInvalid({
        message: `Run "${runId}" was started from a different request — pass a new --id to start a new run.`,
      }),
    );
  }
  return Result.ok(adoptingCodePublication(existing.value, codePublication));
}

async function startNewRun(
  { startingPoint }: RunCapabilities,
  store: RunStore,
  input: Omit<RunTarget, 'requiredStores'> & { request: string },
): Promise<Result<RunState, RunStoreFailure | RepositoryInvalid | GitCommandFailed>> {
  const start = await startingPoint();
  if (start.isErr()) return Result.err(start.error);
  const started = startRun({ ...input, ...start.value });
  const saved = await store.save(started);
  return saved.isErr() ? Result.err(saved.error) : Result.ok(started);
}

/**
 * A run saved before it could defer its code keeps every recorded field, starting commit
 * included, and defers from here on: what it already published stays, nothing more is pushed.
 */
function adoptingCodePublication(state: RunState, codePublication?: CodePublication): RunState {
  return codePublication && !state.codePublication ? { ...state, codePublication } : state;
}

/**
 * Checks credentials and the image before anything is started, then runs the engine inside the
 * sandbox. Telemetry starts before the sandbox and shuts down after it, so it records the whole run.
 */
async function advance(
  { sandbox, log }: RunCapabilities,
  store: RunStore,
  state: RunState,
): Promise<Result<EngineResult, AdvanceFailure>> {
  const credentials = sandbox.checkCredentials();
  if (credentials.isErr()) return Result.err(credentials.error);
  const image = await sandbox.ensureImage();
  if (image.isErr()) return Result.err(image.error);
  return withResource(telemetryLifetime(sandbox), log, (telemetry) =>
    withResource(scopeLifetime(sandbox, log, { state, store, telemetry }), log, (scope) =>
      runEngine(runFlow, state, scope.engineDependencies),
    ),
  );
}

function telemetryLifetime(sandbox: RunSandbox): Lifetime<RunTelemetry | undefined, never, never> {
  return {
    acquire: async () => Result.ok(await sandbox.startTelemetry()),
    release: async (telemetry) => {
      await telemetry?.shutdown();
      return Result.ok();
    },
  };
}

/** The sandbox is closed before the scope is disposed: disposing alone would leave it running. */
function scopeLifetime(
  sandbox: RunSandbox,
  log: WarningLog,
  { state, store, telemetry }: { state: RunState; store: RunStore; telemetry?: RunTelemetry },
): Lifetime<RunScope, SandboxOpenFailure, SessionCloseFailure> {
  return {
    acquire: () => sandbox.openScope(state, store, telemetry),
    release: (scope) =>
      releaseInOrder(
        [
          () => scope.closeSession(),
          async () => {
            await scope.dispose();
            return Result.ok();
          },
        ],
        log,
      ),
  };
}

/** Leaves this machine's record of where the invocation stopped. */
async function recordInvocation(
  records: InvocationRecords,
  report: RunReport,
): Promise<Result<void, MetricsLogCorrupt | LocalStateUnwritable>> {
  const { state, status } = report;
  const metrics = records.metricsSummary(state.runId);
  if (metrics.isErr()) return Result.err(metrics.error);
  return records.recordInvocation(invocationRecord(state, status, metrics.value));
}
