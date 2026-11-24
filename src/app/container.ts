import { asFunction, asValue, type AwilixContainer, createContainer, InjectionMode } from 'awilix';
import { Result } from 'better-result';
import type { Logger } from 'pino';

import {
  type ConfigDestination,
  configDestination,
  configFileSource,
} from '../adapters/filesystem/config-source.js';
import { presetDirectoriesSource } from '../adapters/filesystem/preset-source.js';
import { getCurrentBranch } from '../adapters/git/branch.js';
import { GitWorkspace } from '../adapters/git/git-workspace.js';
import { exactHead } from '../adapters/git/run-history.js';
import { throwawayBranches } from '../adapters/git/throwaway-branches.js';
import { LocalRunRecords } from '../adapters/local-store/local-run-records.js';
import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { lockRun } from '../adapters/local-store/run-lock.js';
import { runLogFile } from '../adapters/local-store/run-paths.js';
import { createConsoleLogger, createRunLogger } from '../adapters/logging/create-logger.js';
import { RepositoryRunStores } from '../adapters/run-store/repository-run-stores.js';
import { DockerImages } from '../adapters/sandbox-image/docker-images.js';
import { latestAgentVersions } from '../adapters/sandbox-image/latest-agent-versions.js';
import { RepositoryStarterFiles } from '../adapters/sandbox-image/starter-files.js';
import { RepositoryAgentCredentials } from '../adapters/sandcastle/agent-credentials.js';
import {
  openSandcastleSession,
  type OpenSessionInput,
  stepCredentials,
} from '../adapters/sandcastle/open-session.js';
import { startTelemetry, type Telemetry } from '../adapters/telemetry/open-telemetry.js';
import type { ConfigSource } from '../config/config-source.js';
import type { JigEnvironment } from '../config/environment.js';
import { type JigConfig, runSettingsFrom } from '../config/load-config.js';
import type { PresetSource } from '../config/preset-source.js';
import type { RunIdentity } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import { retryResult } from '../failures/retry.js';
import type { EngineDependencies } from '../flow/engine.js';
import { transientRetryPolicy } from '../flow/retry-policy.js';
import { LoggingObserver } from '../observers/logging-observer.js';
import { MetricsObserver } from '../observers/metrics.js';
import { RunEvents } from '../observers/run-events.js';
import { TracingObserver } from '../observers/tracing-observer.js';
import type { GitCommandFailed, RepositoryInvalid } from '../ports/git-failures.js';
import type { Clock, LogFormat, RunTelemetry } from '../ports/observability.js';
import type { RunSession } from '../ports/run-session.js';
import type { RunStore, RunStoreCatalog } from '../ports/run-store.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import type { Workspace } from '../ports/workspace.js';
import { releasingOnPanic } from './lifecycle.js';
import { observedEvents } from './observed-events.js';
import type { RunCapabilities, RunScope, StartingPoint } from './run-jig.js';
import type { RunRuntime, RuntimeRequest } from './run-operation.js';
import {
  type EnsureImageDependencies,
  ensureSandboxImage,
  sandboxImageName,
} from './sandbox-image.js';
import type {
  SandboxCapabilities,
  SandboxOpenFailure,
  SandboxRuntime,
  SandboxSettings,
} from './sandbox-runtime.js';
import type { ThrowawaySandboxes } from './throwaway-sandbox.js';

/** Lives for one run: its sandbox, its log file, its events. Disposed when the run stops. */
export interface RunCradle extends AppCradle {
  run: RunIdentity;
  runStore: RunStore;
  runLogger: Logger;
  metricsLog: MetricsLog;
  events: RunEvents;
  session: RunSession;
  workspace: Workspace;
  engineDependencies: EngineDependencies;
}

/** Lives for the whole process: configuration and everything shared by every run. */
export interface AppCradle {
  repoRoot: string;
  environment: JigEnvironment;
  logFormat: LogFormat;
  logLevel: string;
  configDestination: ConfigDestination;
  configSource: ConfigSource;
  config: JigConfig;
  presetSource: PresetSource;
  settings: RunSettings;
  logger: Logger;
  clock: Clock;
  runStores: RunStoreCatalog;
  images: SandboxImages;
  latestVersions: (npmPackages: string[]) => Promise<Record<string, string | undefined>>;
  openSession: (input: OpenSessionInput) => Promise<Result<RunSession, SandboxOpenFailure>>;
}

/**
 * Builds the container a run works in and hands back its capabilities; `dispose` releases what
 * the container built. Spike #49 decides how this construction moves out of `app`.
 */
export function openRunRuntime({ configPath, ...request }: RuntimeRequest): RunRuntime {
  const app = createAppContainer({
    ...request,
    configDestination: configDestination(request.repoRoot, configPath),
  });
  return { run: runCapabilitiesOf(app), dispose: () => app.dispose() };
}

export function createAppContainer(input: {
  repoRoot: string;
  logFormat: LogFormat;
  logLevel?: string;
  environment: JigEnvironment;
  configDestination: ConfigDestination;
  configSource?: ConfigSource;
  config: JigConfig;
  presetSource?: PresetSource;
}): AwilixContainer<AppCradle> {
  const container = createContainer<AppCradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });
  container.register({
    repoRoot: asValue(input.repoRoot),
    environment: asValue(input.environment),
    logFormat: asValue(input.logFormat),
    logLevel: asValue(input.logLevel ?? 'info'),
    configDestination: asValue(input.configDestination),
    configSource: asValue(input.configSource ?? configFileSource(input.configDestination)),
    config: asValue(input.config),
    presetSource: asValue(
      input.presetSource ??
        presetDirectoriesSource({ repoRoot: input.repoRoot, ...input.environment }),
    ),
    settings: asFunction(({ config }: AppCradle) => runSettingsFrom(config)).singleton(),
    logger: asFunction(({ logFormat, logLevel }: AppCradle) =>
      createConsoleLogger(logFormat, logLevel),
    ).singleton(),
    clock: asValue({ now: () => Date.now() }),
    runStores: asFunction(
      ({ repoRoot }: AppCradle) => new RepositoryRunStores(repoRoot),
    ).singleton(),
    images: asFunction(
      ({ logger, environment }: AppCradle) =>
        new DockerImages({
          cache: environment.imageCache,
          onOutput: (line) => logger.debug(line.trimEnd()),
        }),
    ).singleton(),
    latestVersions: asValue(latestAgentVersions),
    openSession: asFunction(
      ({ repoRoot, config, environment, logger }: AppCradle) =>
        (input: OpenSessionInput) =>
          openSandcastleSession(
            {
              repoRoot,
              config,
              environment,
              logger,
              imageName: sandboxImageName(repoRoot, config),
            },
            input,
          ),
    ).singleton(),
  });
  return container;
}

/** The run's capabilities over this container; the run, not the container, decides their order. */
export function runCapabilitiesOf(app: AwilixContainer<AppCradle>): RunCapabilities {
  const { repoRoot, config, environment, logger, runStores } = app.cradle;
  return {
    config,
    log: logger,
    lockRun: (runId) => lockRun(repoRoot, runId),
    runStores,
    startingPoint: () => startingPointOf(repoRoot),
    records: new LocalRunRecords(repoRoot),
    sandbox: {
      checkCredentials: () => stepCredentials(config, environment).map(() => undefined),
      ensureImage: async () =>
        (await ensureSandboxImage(imageDependenciesOf(app.cradle))).map(() => undefined),
      startTelemetry: async () => tracingTelemetry(await startTelemetry(environment.telemetry)),
      openScope: (run, runStore, telemetry) => openRunScope(app, run, runStore, telemetry),
    },
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

function imageDependenciesOf({
  repoRoot,
  config,
  images,
  latestVersions,
  logger,
}: AppCradle): EnsureImageDependencies {
  return { repoRoot, config, images, latestVersions, log: logger };
}

function tracingTelemetry(telemetry: Telemetry | undefined): RunTelemetry | undefined {
  if (!telemetry) return undefined;
  return { observer: new TracingObserver(telemetry.tracer), shutdown: () => telemetry.shutdown() };
}

/**
 * A sandbox that fails to start, or a panic while building the scope, leaves nothing behind: the
 * sandbox opened so far is closed before the scope is disposed.
 */
async function openRunScope(
  app: AwilixContainer<AppCradle>,
  { runId, baseBranch }: RunIdentity,
  runStore: RunStore,
  telemetry: RunTelemetry | undefined,
): Promise<Result<RunScope, SandboxOpenFailure>> {
  const { repoRoot, logger } = app.cradle;
  const run: RunIdentity = { runId, baseBranch };
  const scope = app.createScope<RunCradle>();
  const disposeScope = async (): Promise<Result<void, never>> => {
    await scope.dispose();
    return Result.ok();
  };
  const opened = await releasingOnPanic(
    async () => {
      registerRunServices(scope, { repoRoot, run, runStore, telemetry });
      return openSessionRetrying(scope.cradle);
    },
    [disposeScope],
    logger,
  );
  if (opened.isErr()) {
    await scope.dispose();
    return Result.err(opened.error);
  }
  const session = opened.value;
  return releasingOnPanic(
    async () => Result.ok(handOverRunScope(app, scope, { run, session })),
    [() => session.close(), disposeScope],
    logger,
  );
}

function registerRunServices(
  scope: AwilixContainer<RunCradle>,
  {
    repoRoot,
    run,
    runStore,
    telemetry,
  }: { repoRoot: string; run: RunIdentity; runStore: RunStore; telemetry?: RunTelemetry },
): void {
  scope.register({
    run: asValue(run),
    runStore: asValue(runStore),
    runLogger: asFunction(({ logFormat, logLevel }: RunCradle) =>
      createRunLogger(logFormat, runLogFile(repoRoot, run.runId), logLevel).child({
        runId: run.runId,
      }),
    ).scoped(),
    metricsLog: asFunction(() => new MetricsLog(repoRoot, run.runId)).scoped(),
    events: asFunction(({ runLogger, metricsLog, clock }: RunCradle) =>
      observedEvents(runLogger, [
        new LoggingObserver(runLogger),
        new MetricsObserver((record) => metricsLog.append(record), clock),
        ...(telemetry ? [telemetry.observer] : []),
      ]),
    ).scoped(),
  });
}

/**
 * A sandbox that failed to start for a reason that may pass — Docker, the network under the
 * setup command — gets the same bounded retries as a step; a configuration problem does not.
 */
function openSessionRetrying({
  openSession,
  run,
  events,
  settings,
  runLogger,
}: RunCradle): Promise<Result<RunSession, SandboxOpenFailure>> {
  return retryResult<RunSession, SandboxOpenFailure>(() => openSession({ run, events }), {
    ...transientRetryPolicy(settings),
    onFailedAttempt: ({ error, attempt }) =>
      runLogger.warn({ err: error, attempt }, 'the sandbox did not start'),
  });
}

function handOverRunScope(
  app: AwilixContainer<AppCradle>,
  scope: AwilixContainer<RunCradle>,
  { run, session }: { run: RunIdentity; session: RunSession },
): RunScope {
  scope.register({
    session: asValue(session),
    workspace: asFunction(
      () =>
        new GitWorkspace({
          repoRoot: app.cradle.repoRoot,
          worktreePath: session.worktreePath,
          sandbox: session,
          signing: app.cradle.config.commitSigning,
          ...run,
        }),
    ).scoped(),
    engineDependencies: asFunction(
      ({ workspace, runStore: store, events, clock, settings }: RunCradle): EngineDependencies => ({
        ports: { agent: session, workspace },
        store,
        events,
        clock,
        settings,
      }),
    ).scoped(),
  });
  return {
    engineDependencies: scope.cradle.engineDependencies,
    closeSession: () => session.close(),
    dispose: () => scope.dispose(),
  };
}

/**
 * Builds what `jig init` and `jig build` work with. Each `sandboxFor` builds a container of its
 * own over the settings it is given, sharing this one's log; `dispose` releases every one of them.
 * Spike #49 decides how this construction moves out of `app`.
 */
export function openSandboxRuntime({ configPath, ...request }: RuntimeRequest): SandboxRuntime {
  const destination = configDestination(request.repoRoot, configPath);
  const app = createAppContainer({ ...request, configDestination: destination });
  const { repoRoot, logger } = app.cradle;
  const built = [app];
  return {
    log: logger,
    starterFiles: new RepositoryStarterFiles(repoRoot, destination),
    credentials: new RepositoryAgentCredentials(repoRoot),
    sandboxFor: ({ config, environment }: SandboxSettings) => {
      const settled = createAppContainer({
        ...request,
        configDestination: destination,
        config,
        environment,
      });
      settled.register({ logger: asValue(logger) });
      built.push(settled);
      return sandboxCapabilitiesOf(settled.cradle);
    },
    dispose: async () => {
      for (const container of built) await container.dispose();
    },
  };
}

function sandboxCapabilitiesOf(cradle: AppCradle): SandboxCapabilities {
  return { image: imageDependenciesOf(cradle), throwaway: throwawaySandboxesOf(cradle) };
}

/** A throwaway sandbox's events are logged to the console. */
function throwawaySandboxesOf({ repoRoot, logger, openSession }: AppCradle): ThrowawaySandboxes {
  return {
    ...throwawayBranches(repoRoot),
    log: logger,
    open: (run, setupCommand) =>
      openSession({
        run,
        events: observedEvents(logger, [new LoggingObserver(logger)]),
        setupCommand,
      }),
  };
}
