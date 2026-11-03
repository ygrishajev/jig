import type { AwilixContainer } from 'awilix';
import { Result } from 'better-result';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { lockRun } from '../adapters/local-store/run-lock.js';
import { startTelemetry } from '../adapters/telemetry/open-telemetry.js';
import { type JigError, messageOf, RunRequestInvalid } from '../domain/errors.js';
import { type RunId, runIdSchema } from '../domain/run-id.js';
import { type RunState, startRun } from '../domain/run-state.js';
import { finalStatus } from '../flow/define-flow.js';
import { type EngineResult, runEngine } from '../flow/engine.js';
import { runFlow } from '../flow/run-flow.js';
import { getCurrentBranch } from '../git/branch.js';
import type { RunStore } from '../ports/run-store.js';
import { type AppCradle, withRunScope } from './container.js';
import { openRunStore } from './run-stores.js';
import { ensureSandboxImage } from './sandbox-image.js';

/**
 * Start a run from a request file — named `runId`, or a fresh id — or resume the run `resume`.
 * Starting with the id of an existing run resumes it only when the file is the request it was
 * started with, so a retried CI job resumes safely and a new request is never attached to an old run.
 */
export type RunJigInput = { start: string; runId?: RunId } | { resume: RunId };

export type RunReport = EngineResult;

/**
 * Runs `input` to its next stop. The whole run holds the run's lock, so a second
 * process for the same id fails with `RunInProgress` instead of writing over it. A run that
 * already ended is reported as it is, without touching the sandbox.
 */
export async function runJig(
  app: AwilixContainer<AppCradle>,
  input: RunJigInput,
): Promise<Result<RunReport, JigError>> {
  const runId = 'resume' in input ? input.resume : (input.runId ?? newRunId());
  const releaseLock = await lockRun(app.cradle.repoRoot, runId);
  if (releaseLock.isErr()) return Result.err(releaseLock.error);
  try {
    return await runLocked(app, input, runId);
  } finally {
    await releaseLock.value();
  }
}

function newRunId(): RunId {
  return runIdSchema.parse(randomBytes(4).toString('hex'));
}

function runLocked(
  app: AwilixContainer<AppCradle>,
  input: RunJigInput,
  runId: RunId,
): Promise<Result<RunReport, JigError>> {
  return Result.gen(async function* () {
    const store = yield* Result.await(openRunStore(app.cradle));
    const state = yield* Result.await(startOrResume(app.cradle, store, input, runId));
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
  input: RunJigInput,
  runId: RunId,
): Promise<Result<RunState, JigError>> {
  const existing = await store.load(runId);
  if (existing.isErr()) return Result.err(existing.error);
  if ('resume' in input) {
    return existing.value
      ? Result.ok(existing.value)
      : Result.err(new RunRequestInvalid({ message: `No run found with id "${runId}".` }));
  }
  const request = await readRequest(input.start);
  if (request.isErr()) return Result.err(request.error);
  if (!existing.value) return startNewRun(cradle, store, runId, request.value);
  if (request.value !== existing.value.request) {
    return Result.err(
      new RunRequestInvalid({
        message: `Run "${runId}" was started from a different request — pass a new --id to start a new run.`,
      }),
    );
  }
  return Result.ok(existing.value);
}

function readRequest(file: string): Promise<Result<string, RunRequestInvalid>> {
  return Result.tryPromise({
    try: () => readFile(file, 'utf-8'),
    catch: (error) =>
      new RunRequestInvalid({
        message: `Cannot read the request file "${file}": ${messageOf(error)}`,
      }),
  });
}

async function startNewRun(
  cradle: AppCradle,
  store: RunStore,
  runId: RunId,
  request: string,
): Promise<Result<RunState, JigError>> {
  const baseBranch = await getCurrentBranch(cradle.repoRoot);
  if (baseBranch.isErr()) return Result.err(baseBranch.error);
  const started = startRun({ runId, baseBranch: baseBranch.value, request });
  const saved = await store.save(started);
  return saved.isErr() ? Result.err(saved.error) : Result.ok(started);
}

async function advance(
  app: AwilixContainer<AppCradle>,
  store: RunStore,
  state: RunState,
): Promise<Result<EngineResult, JigError>> {
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
): Promise<Result<void, JigError>> {
  const metrics = new MetricsLog(repoRoot, report.state.runId).summary();
  if (metrics.isErr()) return Result.err(metrics.error);
  return artefacts.write(report.state, report.status, metrics.value);
}
