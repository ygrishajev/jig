import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AwilixContainer } from 'awilix';
import { getCurrentBranch } from '../git/branch.js';
import { RunRequestInvalid } from '../domain/errors.js';
import { runIdSchema, type RunId } from '../domain/run-id.js';
import { startRun, type RunState } from '../domain/run-state.js';
import { runEngine, type EngineStatus } from '../flow/engine.js';
import { runFlow } from '../flow/run-flow.js';
import { summarizeMetrics } from '../observers/metrics.js';
import { closeRunScope, openRunScope, type AppCradle } from './container.js';
import { startTelemetry, telemetryEnabled } from '../adapters/telemetry/open-telemetry.js';
import { lockRun } from '../adapters/local-store/run-lock.js';
import { openRunStore } from './run-stores.js';
import { ensureSandboxImage } from './sandbox-image.js';
import type { RunStore } from '../ports/run-store.js';

export interface RunSdlcInput {
  requestPath?: string;
  runId?: RunId;
}

export interface RunReport {
  state: RunState;
  status: EngineStatus;
}

/**
 * Starts a run from a request file, or resumes an existing one by id. Passing both resumes only
 * when the file is the request the run was started with, so a retried CI job resumes safely and
 * a new request can never be attached to an old run. The whole run holds the run's lock, so a
 * second process for the same id fails with `RunInProgress` instead of writing over it.
 */
export async function runSdlc(
  app: AwilixContainer<AppCradle>,
  input: RunSdlcInput,
): Promise<RunReport> {
  const id = runIdFor(input);
  const releaseLock = await lockRun(app.cradle.repoRoot, id);
  try {
    return await runHoldingLock(app, input.requestPath, id);
  } finally {
    await releaseLock();
  }
}

async function runHoldingLock(
  app: AwilixContainer<AppCradle>,
  requestPath: string | undefined,
  id: RunId,
) {
  const runStore = await openRunStore(app.cradle);
  const state = await startOrResume(app, runStore, requestPath, id);
  await ensureSandboxImage(app.cradle);
  const telemetry = telemetryEnabled(process.env) ? await startTelemetry() : undefined;
  try {
    const scope = await openRunScope(
      app,
      { runId: state.runId, baseBranch: state.baseBranch },
      runStore,
      { tracer: telemetry?.tracer },
    );
    try {
      const result = await runEngine(runFlow, state, scope.cradle.engineDependencies);
      const metrics = summarizeMetrics(scope.cradle.metricsLog.readAll());
      await app.cradle.artefacts.write(result.state, result.status, metrics);
      return result;
    } finally {
      await closeRunScope(scope);
    }
  } finally {
    await telemetry?.shutdown();
  }
}

function runIdFor({ requestPath, runId }: RunSdlcInput) {
  if (!requestPath && !runId) {
    throw new RunRequestInvalid('Pass a request file to start a run, or --id to resume one.');
  }
  return runId ?? runIdSchema.parse(randomBytes(4).toString('hex'));
}

async function startOrResume(
  app: AwilixContainer<AppCradle>,
  store: RunStore,
  requestPath: string | undefined,
  id: RunId,
) {
  const request = requestPath ? await readFile(requestPath, 'utf-8') : undefined;
  const existing = await store.load(id);

  if (existing) {
    if (request !== undefined && request !== existing.request) {
      throw new RunRequestInvalid(
        `Run "${existing.runId}" was started from a different request — pass a new --id to start a new run.`,
      );
    }
    return existing;
  }
  if (request === undefined) throw new RunRequestInvalid(`No run found with id "${id}".`);

  const baseBranch = await getCurrentBranch(app.cradle.repoRoot);
  const started = startRun({ runId: id, baseBranch, request });
  await store.save(started);
  return started;
}
