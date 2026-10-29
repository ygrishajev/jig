import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AwilixContainer } from 'awilix';
import { getCurrentBranch } from '../git/branch.js';
import { RunRequestInvalid } from '../domain/errors.js';
import { RUN_ID_PATTERN, startRun, type RunState } from '../domain/run-state.js';
import { runEngine, type EngineStatus } from '../flow/engine.js';
import { runFlow } from '../flow/run-flow.js';
import { summarizeMetrics } from '../observers/metrics.js';
import { closeRunScope, openRunScope, type AppCradle } from './container.js';
import { startTelemetry, telemetryEnabled } from '../adapters/telemetry/open-telemetry.js';
import { createRunStore } from './run-stores.js';
import { ensureSandboxImage } from './sandbox-image.js';
import type { RunStore } from '../ports/run-store.js';

export interface RunSdlcInput {
  requestPath?: string;
  runId?: string;
}

export interface RunReport {
  state: RunState;
  status: EngineStatus;
}

/**
 * Starts a run from a request file, or resumes an existing one by id. Passing both resumes only
 * when the file is the request the run was started with, so a retried CI job resumes safely and
 * a new request can never be attached to an old run.
 */
export async function runSdlc(
  app: AwilixContainer<AppCradle>,
  input: RunSdlcInput,
): Promise<RunReport> {
  const runStore = await createRunStore({
    repoRoot: app.cradle.repoRoot,
    names: app.cradle.config.runStores,
    local: app.cradle.store,
  });
  const state = await startOrResume(app, runStore, input);
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
      await app.cradle.store.writeResult(result.state, result.status, metrics);
      return result;
    } finally {
      await closeRunScope(scope);
    }
  } finally {
    await telemetry?.shutdown();
  }
}

async function startOrResume(
  app: AwilixContainer<AppCradle>,
  store: RunStore,
  { requestPath, runId }: RunSdlcInput,
) {
  const { repoRoot } = app.cradle;
  if (!requestPath && !runId) {
    throw new RunRequestInvalid('Pass a request file to start a run, or --id to resume one.');
  }
  const request = requestPath ? await readFile(requestPath, 'utf-8') : undefined;
  const existing = runId ? await store.load(runId) : undefined;

  if (existing) {
    if (request !== undefined && request !== existing.request) {
      throw new RunRequestInvalid(
        `Run "${existing.runId}" was started from a different request — pass a new --id to start a new run.`,
      );
    }
    return existing;
  }
  if (request === undefined) throw new RunRequestInvalid(`No run found with id "${runId}".`);

  const id = runId ?? randomBytes(4).toString('hex');
  if (!RUN_ID_PATTERN.test(id)) {
    throw new RunRequestInvalid(
      `Invalid run id "${id}" — use lowercase letters, digits and hyphens (it becomes a directory and a branch name).`,
    );
  }
  const started = startRun({ runId: id, baseBranch: await getCurrentBranch(repoRoot), request });
  await store.save(started);
  return started;
}
