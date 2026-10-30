import type { AwilixContainer } from 'awilix';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { lockRun } from '../adapters/local-store/run-lock.js';
import { startTelemetry, telemetryEnabled } from '../adapters/telemetry/open-telemetry.js';
import { RunRequestInvalid } from '../domain/errors.js';
import { parseRunId, type RunId, runIdSchema } from '../domain/run-id.js';
import { type RunState, startRun } from '../domain/run-state.js';
import { finalStatus } from '../flow/define-flow.js';
import { type EngineResult, runEngine } from '../flow/engine.js';
import { runFlow } from '../flow/run-flow.js';
import { getCurrentBranch } from '../git/branch.js';
import { summarizeMetrics } from '../observers/metrics.js';
import type { RunStore } from '../ports/run-store.js';
import { type AppCradle, closeRunScope, openRunScope } from './container.js';
import { openRunStore } from './run-stores.js';
import { ensureSandboxImage } from './sandbox-image.js';

/**
 * Start a run from a request file — named `runId`, or a fresh id — or resume the run `resume`.
 * Starting with the id of an existing run resumes it only when the file is the request it was
 * started with, so a retried CI job resumes safely and a new request is never attached to an old run.
 */
export type RunSdlcInput = { start: string; runId?: RunId } | { resume: RunId };

export type RunReport = EngineResult;

/** What `sdlc run [request] [--id <id>]` asks for; it needs at least one of the two. */
export function runInputFrom(requestPath?: string, id?: string): RunSdlcInput {
  const runId = id === undefined ? undefined : parseRunId(id);
  if (requestPath !== undefined)
    return runId ? { start: requestPath, runId } : { start: requestPath };
  if (runId) return { resume: runId };
  throw new RunRequestInvalid('Pass a request file to start a run, or --id to resume one.');
}

/**
 * Runs `input` to its next stop. The whole run holds the run's lock, so a second process for the
 * same id fails with `RunInProgress` instead of writing over it. A run that already ended is
 * reported as it is, without touching the sandbox.
 */
export async function runSdlc(
  app: AwilixContainer<AppCradle>,
  input: RunSdlcInput,
): Promise<RunReport> {
  const runId = 'resume' in input ? input.resume : (input.runId ?? newRunId());
  const releaseLock = await lockRun(app.cradle.repoRoot, runId);
  try {
    const store = await openRunStore(app.cradle);
    const state = await startOrResume(app.cradle, store, input, runId);
    const finished = finalStatus(runFlow, state);
    const report = finished ? { state, status: finished } : await advance(app, store, state);
    await recordInvocation(app.cradle, report);
    return report;
  } finally {
    await releaseLock();
  }
}

function newRunId() {
  return runIdSchema.parse(randomBytes(4).toString('hex'));
}

async function startOrResume(
  cradle: AppCradle,
  store: RunStore,
  input: RunSdlcInput,
  runId: RunId,
): Promise<RunState> {
  const existing = await store.load(runId);
  if ('resume' in input) {
    if (!existing) throw new RunRequestInvalid(`No run found with id "${runId}".`);
    return existing;
  }
  const request = await readFile(input.start, 'utf-8');
  if (!existing) return startNewRun(cradle, store, runId, request);
  if (request !== existing.request) {
    throw new RunRequestInvalid(
      `Run "${runId}" was started from a different request — pass a new --id to start a new run.`,
    );
  }
  return existing;
}

async function startNewRun(cradle: AppCradle, store: RunStore, runId: RunId, request: string) {
  const baseBranch = await getCurrentBranch(cradle.repoRoot);
  const started = startRun({ runId, baseBranch, request });
  await store.save(started);
  return started;
}

async function advance(app: AwilixContainer<AppCradle>, store: RunStore, state: RunState) {
  await ensureSandboxImage(app.cradle);
  const { environment } = app.cradle;
  const telemetry = telemetryEnabled(environment) ? await startTelemetry(environment) : undefined;
  try {
    const run = { runId: state.runId, baseBranch: state.baseBranch };
    const scope = await openRunScope(app, run, store, { tracer: telemetry?.tracer });
    try {
      return await runEngine(runFlow, state, scope.cradle.engineDependencies);
    } finally {
      await closeRunScope(scope);
    }
  } finally {
    await telemetry?.shutdown();
  }
}

/** Leaves this machine's record of where the invocation stopped; see `RunArtefacts`. */
async function recordInvocation({ repoRoot, artefacts }: AppCradle, report: RunReport) {
  const metrics = summarizeMetrics(new MetricsLog(repoRoot, report.state.runId).readAll());
  await artefacts.write(report.state, report.status, metrics);
}
