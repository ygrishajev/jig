import { Result } from 'better-result';

import { getCurrentBranch } from '../adapters/git/branch.js';
import { GitWorkspace } from '../adapters/git/git-workspace.js';
import { exactHead } from '../adapters/git/run-history.js';
import { LocalRunRecords } from '../adapters/local-store/local-run-records.js';
import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { lockRun } from '../adapters/local-store/run-lock.js';
import { runLogFile } from '../adapters/local-store/run-paths.js';
import { createRunLogger } from '../adapters/logging/create-logger.js';
import { RepositoryRunStores } from '../adapters/run-store/repository-run-stores.js';
import { stepCredentials } from '../adapters/sandcastle/open-session.js';
import { startTelemetry, type Telemetry } from '../adapters/telemetry/open-telemetry.js';
import type { RunRuntime, RunSandbox, RuntimeRequest, StartingPoint } from '../app/api.js';
import { acquireRunScope, type RunReporting, type RunScopeParts } from '../app/run-scope.js';
import { ensureSandboxImage } from '../app/sandbox-image.js';
import type { RunIdentity } from '../domain/run-state.js';
import { LoggingObserver } from '../observers/logging-observer.js';
import { MetricsObserver } from '../observers/metrics.js';
import { TracingObserver } from '../observers/tracing-observer.js';
import type { GitCommandFailed, RepositoryInvalid } from '../ports/git-failures.js';
import type { Clock, LogFormat, RunTelemetry } from '../ports/observability.js';
import { observedEvents } from './observed-events.js';
import {
  type ConsoleWiring,
  imageDependencies,
  type ImageWiring,
  productionConsole,
  productionImages,
  productionSessions,
  productionSettings,
  type SandboxSetting,
  sessionContext,
  type SessionWiring,
  type SettingsWiring,
} from './runtime-wiring.js';

export type RunRuntimeWiring = ConsoleWiring & ImageWiring & SessionWiring & SettingsWiring;

/** What a run's scope is opened with: the run log's level, the session opener and the settings. */
type ScopeWiring = Pick<ConsoleWiring, 'logLevel'> & SessionWiring & SettingsWiring;

/**
 * Opens what a run works with over `wiring`. Opening it builds nothing that needs releasing: the
 * image, the sandbox and the run's log are only made when the run asks for them.
 */
export function runRuntimeFactory(
  overrides: Partial<RunRuntimeWiring> = {},
): (request: RuntimeRequest) => RunRuntime {
  const wiring: RunRuntimeWiring = {
    ...productionConsole,
    ...productionImages,
    ...productionSessions,
    ...productionSettings,
    ...overrides,
  };
  return (request) => openRunRuntime(wiring, request);
}

function openRunRuntime(
  wiring: RunRuntimeWiring,
  { repoRoot, config, environment, logFormat }: RuntimeRequest,
): RunRuntime {
  const log = wiring.consoleLog(logFormat, wiring.logLevel);
  const setting: SandboxSetting = { repoRoot, config, environment, log };
  return {
    run: {
      config,
      log,
      lockRun: (runId) => lockRun(repoRoot, runId),
      runStores: new RepositoryRunStores(repoRoot),
      startingPoint: () => startingPointOf(repoRoot),
      records: new LocalRunRecords(repoRoot),
      sandbox: runSandbox(wiring, setting, logFormat),
    },
    dispose: async () => {},
  };
}

async function startingPointOf(
  repoRoot: string,
): Promise<Result<StartingPoint, RepositoryInvalid | GitCommandFailed>> {
  const baseBranch = await getCurrentBranch(repoRoot);
  if (baseBranch.isErr()) return Result.err(baseBranch.error);
  const startingCommit = await exactHead(repoRoot, 'HEAD');
  if (startingCommit.isErr()) return Result.err(startingCommit.error);
  return Result.ok({ baseBranch: baseBranch.value, startingCommit: startingCommit.value });
}

function runSandbox(
  wiring: ImageWiring & ScopeWiring,
  setting: SandboxSetting,
  logFormat: LogFormat,
): RunSandbox {
  const { config, environment } = setting;
  return {
    checkCredentials: () => stepCredentials(config, environment).map(() => undefined),
    ensureImage: async () =>
      (await ensureSandboxImage(imageDependencies(wiring, setting))).map(() => undefined),
    startTelemetry: async () => tracingTelemetry(await startTelemetry(environment.telemetry)),
    openScope: (run, store, telemetry) =>
      acquireRunScope(runScopeParts(wiring, setting, logFormat), run, store, telemetry),
  };
}

function tracingTelemetry(telemetry: Telemetry | undefined): RunTelemetry | undefined {
  if (!telemetry) return undefined;
  return { observer: new TracingObserver(telemetry.tracer), shutdown: () => telemetry.shutdown() };
}

function runScopeParts(
  { logLevel, openSession, runSettings }: ScopeWiring,
  setting: SandboxSetting,
  logFormat: LogFormat,
): RunScopeParts {
  const { repoRoot, config, log } = setting;
  return {
    settings: runSettings(config),
    clock: systemClock,
    log,
    reportingFor: (run, telemetry) =>
      runReporting({ repoRoot, logFormat, logLevel }, run, telemetry),
    openSession: (run, events) => openSession(sessionContext(setting), { run, events }),
    workspaceFor: (run, session) =>
      new GitWorkspace({
        repoRoot,
        worktreePath: session.worktreePath,
        sandbox: session,
        signing: config.commitSigning,
        ...run,
      }),
  };
}

const systemClock: Clock = { now: () => Date.now() };

/**
 * The run's own log file, which the console also hears, its metrics and its events. The log file
 * stays open for the life of the process, so a late line still reaches it.
 */
function runReporting(
  { repoRoot, logFormat, logLevel }: { repoRoot: string; logFormat: LogFormat; logLevel: string },
  { runId }: RunIdentity,
  telemetry: RunTelemetry | undefined,
): RunReporting {
  const runLogger = createRunLogger(logFormat, runLogFile(repoRoot, runId), logLevel).child({
    runId,
  });
  const metricsLog = new MetricsLog(repoRoot, runId);
  const events = observedEvents(runLogger, [
    new LoggingObserver(runLogger),
    new MetricsObserver((record) => metricsLog.append(record), systemClock),
    ...(telemetry ? [telemetry.observer] : []),
  ]);
  return {
    events,
    log: runLogger,
    dispose: async () => {
      events.removeAllListeners();
    },
  };
}
