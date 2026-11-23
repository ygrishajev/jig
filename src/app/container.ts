import type { Tracer } from '@opentelemetry/api';
import { asFunction, asValue, type AwilixContainer, createContainer, InjectionMode } from 'awilix';
import { Result } from 'better-result';
import type { Logger } from 'pino';

import { exceptionDetails } from '../adapters/exception-details.js';
import { type ConfigDestination, configFileSource } from '../adapters/filesystem/config-source.js';
import { presetDirectoriesSource } from '../adapters/filesystem/preset-source.js';
import { GitWorkspace } from '../adapters/git/git-workspace.js';
import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { RunArtefacts } from '../adapters/local-store/run-artefacts.js';
import { runLogFile } from '../adapters/local-store/run-paths.js';
import {
  createConsoleLogger,
  createRunLogger,
  type LogFormat,
} from '../adapters/logging/create-logger.js';
import { retryResult } from '../adapters/retry.js';
import { DockerImages } from '../adapters/sandbox-image/docker-images.js';
import { latestAgentVersions } from '../adapters/sandbox-image/latest-agent-versions.js';
import type { MissingCredential } from '../adapters/sandcastle/agents.js';
import {
  openSandcastleSession,
  type OpenSessionInput,
} from '../adapters/sandcastle/open-session.js';
import type {
  SessionCloseFailure,
  SessionOpenFailure,
} from '../adapters/sandcastle/sandcastle-session.js';
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
import { transientRetryPolicy } from '../domain/retry.js';
import { type RunIdentity } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { EngineDependencies } from '../flow/engine.js';
import { LoggingObserver } from '../observers/logging-observer.js';
import { MetricsObserver } from '../observers/metrics.js';
import { RunEvents } from '../observers/run-events.js';
import { TracingObserver } from '../observers/tracing-observer.js';
import type { AgentSession } from '../ports/agent-session.js';
import type { ExceptionDetails } from '../ports/exception-details.js';
import type { Clock } from '../ports/observability.js';
import type { RetryResult } from '../ports/retry.js';
import type { RunStore } from '../ports/run-store.js';
import type { SandboxGit } from '../ports/sandbox-git.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import type { Workspace } from '../ports/workspace.js';
import { observedEvents } from './observed-events.js';
import { reportCleanup } from './report-cleanup.js';
import { sandboxImageName } from './sandbox-image.js';

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
  retryResult: RetryResult;
  exceptionDetails: ExceptionDetails;
  artefacts: RunArtefacts;
  images: SandboxImages;
  latestVersions: (npmPackages: string[]) => Promise<Record<string, string | undefined>>;
  openSession: (input: OpenSessionInput) => Promise<Result<RunSession, SessionOpenFailure>>;
  askForAgents: (
    roles: AgentRole[],
  ) => Promise<Partial<Record<AgentRole, AgentChoice>> | undefined>;
  askForCredential: (missing: MissingCredential) => Promise<EnteredCredential | undefined>;
}

/** The run's sandbox: where agents and commands run, and the host worktree of the run branch. */
export interface RunSession extends AgentSession, SandboxGit {
  readonly worktreePath: string;
  close(): Promise<Result<void, SessionCloseFailure>>;
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
    retryResult: asValue(retryResult),
    exceptionDetails: asValue(exceptionDetails),
    artefacts: asFunction(({ repoRoot }: AppCradle) => new RunArtefacts(repoRoot)).singleton(),
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

/**
 * Starts the run's sandbox, builds everything scoped to the run and hands `use` what the engine
 * needs. The sandbox is closed and the scope disposed afterwards, however `use` ends.
 */
export async function withRunScope<T, E>(
  app: AwilixContainer<AppCradle>,
  { runId, baseBranch }: RunIdentity,
  runStore: RunStore,
  options: { tracer?: Tracer },
  use: (dependencies: EngineDependencies) => Promise<Result<T, E>>,
): Promise<Result<T, SessionOpenFailure | SessionCloseFailure | E>> {
  const scope = await openRunScope(app, { runId, baseBranch }, runStore, options);
  if (scope.isErr()) return Result.err(scope.error);
  let used: Result<T, E>;
  let closed: Result<void, SessionCloseFailure>;
  try {
    used = await use(scope.value.cradle.engineDependencies);
  } finally {
    closed = await closeRunScope(scope.value);
  }
  return reportCleanup(used, closed, app.cradle.logger);
}

async function openRunScope(
  app: AwilixContainer<AppCradle>,
  run: RunIdentity,
  runStore: RunStore,
  options: { tracer?: Tracer },
): Promise<Result<AwilixContainer<RunCradle>, SessionOpenFailure>> {
  const { repoRoot } = app.cradle;
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
        ...(options.tracer ? [new TracingObserver(options.tracer)] : []),
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
      ({
        workspace,
        runStore: store,
        events,
        clock,
        settings,
        retryResult,
        exceptionDetails,
      }: RunCradle): EngineDependencies => ({
        ports: { agent: session, workspace, retryResult },
        store,
        events,
        clock,
        settings,
        exceptionDetails,
      }),
    ).scoped(),
  });
  return Result.ok(scope);
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
  retryResult,
}: RunCradle): Promise<Result<RunSession, SessionOpenFailure>> {
  return retryResult<RunSession, SessionOpenFailure>(() => openSession({ run, events }), {
    ...transientRetryPolicy(settings),
    onFailedAttempt: ({ error, attempt }) =>
      runLogger.warn({ err: error, attempt }, 'the sandbox did not start'),
  });
}

/** Awilix's `dispose` alone would leave the sandbox running, so the session is closed first. */
async function closeRunScope(
  scope: AwilixContainer<RunCradle>,
): Promise<Result<void, SessionCloseFailure>> {
  try {
    return await scope.cradle.session.close();
  } finally {
    await scope.dispose();
  }
}
