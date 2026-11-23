import type { AwilixContainer } from 'awilix';
import { Result } from 'better-result';

import { getCurrentBranch } from '../adapters/git/branch.js';
import { exactHead } from '../adapters/git/run-history.js';
import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { lockRun } from '../adapters/local-store/run-lock.js';
import { stepCredentials } from '../adapters/sandcastle/open-session.js';
import { startTelemetry } from '../adapters/telemetry/open-telemetry.js';
import type { ConfigInvalid } from '../config/errors.js';
import { validationWarnings } from '../config/load-config.js';
import { newRunId, type RunId } from '../domain/run-id.js';
import { type CodePublication, type RunState, startRun } from '../domain/run-state.js';
import { finalStatus } from '../flow/define-flow.js';
import { type EngineFailure, type EngineResult, runEngine } from '../flow/engine.js';
import type { CredentialsInvalid } from '../ports/credentials.js';
import { type LocalStateUnwritable } from '../ports/filesystem.js';
import type { RepositoryInvalid } from '../ports/git-failures.js';
import { type MetricsLogCorrupt } from '../ports/metrics.js';
import type { RunInProgress } from '../ports/run-state-failures.js';
import type { RunStore, RunStoreLoadFailure, RunStoreSaveFailure } from '../ports/run-store.js';
import type {
  ImageBuildFailed,
  ImageRecipeInvalid,
  SessionCloseFailure,
  SessionOpenFailure,
} from '../ports/sandbox.js';
import { type AppCradle, withRunScope } from './container.js';
import { runFlow } from './run-flow.js';
import { RunRequestInvalid } from './run-request-invalid.js';
import type { RunStoreSetupInvalid } from './run-store-setup-invalid.js';
import { openRunStore } from './run-stores.js';
import { ensureSandboxImage } from './sandbox-image.js';

export type RunJigFailure =
  | AdvanceFailure
  | RunStoreLoadFailure
  | RunStoreSetupInvalid
  | RunRequestInvalid
  | RunInProgress
  | MetricsLogCorrupt
  | LocalStateUnwritable
  | RepositoryInvalid;
export type AdvanceFailure =
  | ConfigInvalid
  | CredentialsInvalid
  | ImageRecipeInvalid
  | ImageBuildFailed
  | SessionOpenFailure
  | SessionCloseFailure
  | EngineFailure;

/**
 * Start a run from a request — named `runId`, or a fresh id — or resume the run `resume`.
 * Starting with the id of an existing run resumes it only when the text is the request it was
 * started with, so a retried CI job resumes safely and a new request is never attached to an old run.
 */
export type RunJigInput =
  { start: StartRequest; runId?: RunId; requiredStores?: string[] } | { resume: RunId };

/** The text of a request and, when it came from one, the file it was read from. */
export type StartRequest = {
  text: string;
  file?: string;
  merge?: boolean;
  codePublication?: CodePublication;
};

export type RunReport = EngineResult;

/** The run to start or resume: its id, and the request text when one was given. */
type RunTarget = {
  runId: RunId;
  request?: string;
  merge?: boolean;
  codePublication?: CodePublication;
  requiredStores?: string[];
};

/**
 * Runs `input` to its next stop. The whole run holds the run's lock, so a second
 * process for the same id fails with `RunInProgress` instead of writing over it. A run that
 * already ended is reported as it is, without touching the sandbox.
 */
export async function runJig(
  app: AwilixContainer<AppCradle>,
  input: RunJigInput,
): Promise<Result<RunReport, RunJigFailure>> {
  const target = targetOf(input);
  const releaseLock = await lockRun(app.cradle.repoRoot, target.runId);
  if (releaseLock.isErr()) return Result.err(releaseLock.error);
  try {
    return await runLocked(app, target);
  } finally {
    await releaseLock.value();
  }
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

function runLocked(
  app: AwilixContainer<AppCradle>,
  target: RunTarget,
): Promise<Result<RunReport, Exclude<RunJigFailure, RunInProgress>>> {
  return Result.gen(async function* () {
    const store = yield* Result.await(openRunStore(app.cradle, target.requiredStores));
    const state = yield* Result.await(startOrResume(app.cradle, store, target));
    for (const warning of validationWarnings(app.cradle.config)) app.cradle.logger.warn(warning);
    const finished = finalStatus(runFlow, state);
    const report = finished
      ? { state, status: finished }
      : yield* Result.await(advance(app, store, state));
    yield* Result.await(recordInvocation(app.cradle, report));
    return Result.ok(report);
  });
}

async function startOrResume(
  cradle: AppCradle,
  store: RunStore,
  { runId, request, merge, codePublication }: RunTarget,
): Promise<Result<RunState, RunStoreLoadFailure | RepositoryInvalid | RunRequestInvalid>> {
  const existing = await store.load(runId);
  if (existing.isErr()) return Result.err(existing.error);
  if (request === undefined) {
    return existing.value
      ? Result.ok(existing.value)
      : Result.err(new RunRequestInvalid({ message: `No run found with id "${runId}".` }));
  }
  if (!existing.value)
    return startNewRun(cradle, store, { runId, request, merge, codePublication });
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
  cradle: AppCradle,
  store: RunStore,
  input: Omit<RunTarget, 'requiredStores'> & { request: string },
): Promise<Result<RunState, RunStoreSaveFailure | RepositoryInvalid>> {
  const baseBranch = await getCurrentBranch(cradle.repoRoot);
  if (baseBranch.isErr()) return Result.err(baseBranch.error);
  const startingCommit = await exactHead(cradle.repoRoot, 'HEAD');
  if (startingCommit.isErr()) return Result.err(startingCommit.error);
  const started = startRun({
    ...input,
    baseBranch: baseBranch.value,
    startingCommit: startingCommit.value,
  });
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

async function advance(
  app: AwilixContainer<AppCradle>,
  store: RunStore,
  state: RunState,
): Promise<Result<EngineResult, AdvanceFailure>> {
  const credentials = stepCredentials(app.cradle.config, app.cradle.environment);
  if (credentials.isErr()) return Result.err(credentials.error);
  const image = await ensureSandboxImage(app.cradle);
  if (image.isErr()) return Result.err(image.error);
  const telemetry = await startTelemetry(app.cradle.environment.telemetry);
  try {
    return await withRunScope(app, state, store, { tracer: telemetry?.tracer }, (dependencies) =>
      runEngine(runFlow, state, dependencies),
    );
  } finally {
    await telemetry?.shutdown();
  }
}

/** Leaves this machine's record of where the invocation stopped; see `RunArtefacts`. */
async function recordInvocation(
  { repoRoot, artefacts }: AppCradle,
  report: RunReport,
): Promise<Result<void, MetricsLogCorrupt | LocalStateUnwritable>> {
  const metrics = new MetricsLog(repoRoot, report.state.runId).summary();
  if (metrics.isErr()) return Result.err(metrics.error);
  return artefacts.write(report.state, report.status, metrics.value);
}
