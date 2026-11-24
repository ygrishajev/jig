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
import { LocalRunRecords } from '../adapters/local-store/local-run-records.js';
import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { lockRun } from '../adapters/local-store/run-lock.js';
import { runLogFile } from '../adapters/local-store/run-paths.js';
import {
  createConsoleLogger,
  createRunLogger,
  type LogFormat,
} from '../adapters/logging/create-logger.js';
import { RepositoryRunStores } from '../adapters/run-store/repository-run-stores.js';
import { DockerImages } from '../adapters/sandbox-image/docker-images.js';
import { latestAgentVersions } from '../adapters/sandbox-image/latest-agent-versions.js';
import type { MissingCredential } from '../adapters/sandcastle/agents.js';
import {
  openSandcastleSession,
  type OpenSessionInput,
  stepCredentials,
} from '../adapters/sandcastle/open-session.js';
import type { SessionOpenFailure } from '../adapters/sandcastle/sandcastle-session.js';
import { startTelemetry, type Telemetry } from '../adapters/telemetry/open-telemetry.js';
import { askForAgents } from '../adapters/terminal/ask-for-agents.js';
import {
  askForCredential,
  type EnteredCredential,
} from '../adapters/terminal/ask-for-credential.js';
import type { AgentChoice } from '../config/agent-policy.js';
import type { ConfigSource } from '../config/config-source.js';
import type { JigEnvironment } from '../config/environment.js';
import { type JigConfig, runSettingsFrom } from '../config/load-config.js';
import type { PresetSource } from '../config/preset-source.js';
import type { AgentRole } from '../domain/agent-role.js';
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
import type { Clock, RunTelemetry } from '../ports/observability.js';
import type { RunSession } from '../ports/run-session.js';
import type { RunStore, RunStoreCatalog } from '../ports/run-store.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import type { Workspace } from '../ports/workspace.js';
import { observedEvents } from './observed-events.js';
import type { RunCapabilities, RunScope, StartingPoint } from './run-jig.js';
import type { RunRuntime, RuntimeRequest } from './run-operation.js';
import { ensureSandboxImage, sandboxImageName } from './sandbox-image.js';

export type App = AwilixContainer<AppCradle>;

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
  openSession: (input: OpenSessionInput) => Promise<Result<RunSession, SessionOpenFailure>>;
  askForAgents: (
    roles: AgentRole[],
  ) => Promise<Partial<Record<AgentRole, AgentChoice>> | undefined>;
  askForCredential: (missing: MissingCredential) => Promise<EnteredCredential | undefined>;
}

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
    askForAgents: asValue((roles: AgentRole[]) => askForAgents(roles)),
    askForCredential: asValue((missing: MissingCredential) => askForCredential(missing)),
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
      ensureImage: async () => (await ensureSandboxImage(app.cradle)).map(() => undefined),
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

function tracingTelemetry(telemetry: Telemetry | undefined): RunTelemetry | undefined {
  if (!telemetry) return undefined;
  return { observer: new TracingObserver(telemetry.tracer), shutdown: () => telemetry.shutdown() };
}

/** A sandbox that fails to start leaves no scope behind: what was built for it is disposed. */
async function openRunScope(
  app: AwilixContainer<AppCradle>,
  { runId, baseBranch }: RunIdentity,
  runStore: RunStore,
  telemetry: RunTelemetry | undefined,
): Promise<Result<RunScope, SessionOpenFailure>> {
  const { repoRoot } = app.cradle;
  const run: RunIdentity = { runId, baseBranch };
  const scope = app.createScope<RunCradle>();
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

  const opened = await openSessionRetrying(scope.cradle);
  if (opened.isErr()) {
    await scope.dispose();
    return Result.err(opened.error);
  }
  const session = opened.value;
  scope.register({
    session: asValue(session),
    workspace: asFunction(
      () =>
        new GitWorkspace({
          repoRoot,
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
  return Result.ok({
    engineDependencies: scope.cradle.engineDependencies,
    closeSession: () => session.close(),
    dispose: () => scope.dispose(),
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
}: RunCradle): Promise<Result<RunSession, SessionOpenFailure>> {
  return retryResult<RunSession, SessionOpenFailure>(() => openSession({ run, events }), {
    ...transientRetryPolicy(settings),
    onFailedAttempt: ({ error, attempt }) =>
      runLogger.warn({ err: error, attempt }, 'the sandbox did not start'),
  });
}
