import type { AgentProvider } from '@ai-hero/sandcastle';
import type { Tracer } from '@opentelemetry/api';
import { asFunction, asValue, type AwilixContainer, createContainer, InjectionMode } from 'awilix';
import path from 'node:path';
import pRetry from 'p-retry';
import type { Logger } from 'pino';

import { GitWorkspace } from '../adapters/git/git-workspace.js';
import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { RunArtefacts } from '../adapters/local-store/run-artefacts.js';
import { stateDirectory } from '../adapters/local-store/run-paths.js';
import {
  createConsoleLogger,
  createRunLogger,
  type LogFormat,
} from '../adapters/logging/create-logger.js';
import { DockerImages } from '../adapters/sandbox-image/docker-images.js';
import { latestAgentVersions } from '../adapters/sandbox-image/latest-agent-versions.js';
import { AGENTS, collectCredentials } from '../adapters/sandcastle/agents.js';
import { sandcastleEnvKeys } from '../adapters/sandcastle/sandcastle-env.js';
import {
  SandcastleSession,
  type SandcastleSessionOptions,
} from '../adapters/sandcastle/sandcastle-session.js';
import { sandboxTelemetryEnvironment } from '../adapters/telemetry/open-telemetry.js';
import type { JigEnvironment } from '../config/environment.js';
import {
  configuredSteps,
  type JigConfig,
  loadConfig,
  runSettingsFrom,
} from '../config/load-config.js';
import { type AgentRole, byRole } from '../domain/agent-role.js';
import { isTransient } from '../domain/errors.js';
import type { RunId } from '../domain/run-id.js';
import type { RunSettings } from '../domain/settings.js';
import type { EngineDependencies } from '../flow/engine.js';
import { LoggingObserver } from '../observers/logging-observer.js';
import { MetricsObserver } from '../observers/metrics.js';
import { observe, RunEvents } from '../observers/run-events.js';
import { TracingObserver } from '../observers/tracing-observer.js';
import type { AgentSession } from '../ports/agent-session.js';
import type { Clock, EventSink } from '../ports/observability.js';
import type { RunStore } from '../ports/run-store.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import type { Workspace } from '../ports/workspace.js';
import { sandboxImageName } from './sandbox-image.js';

export interface RunIdentity {
  runId: RunId;
  baseBranch: string;
}

/** The run's sandbox: where agents and commands run, and the worktree they share with the host. */
export interface RunSession extends AgentSession {
  readonly worktreePath: string;
  close(): Promise<void>;
}

export interface OpenSessionInput {
  run: RunIdentity;
  events: EventSink;
  /** Overrides the configured setup command; `null` starts the sandbox without one. */
  setupCommand?: string | null;
}

/** Lives for the whole process: configuration and everything shared by every run. */
export interface AppCradle {
  repoRoot: string;
  environment: JigEnvironment;
  logFormat: LogFormat;
  logLevel: string;
  config: JigConfig;
  settings: RunSettings;
  logger: Logger;
  clock: Clock;
  artefacts: RunArtefacts;
  images: SandboxImages;
  latestVersions: (npmPackages: string[]) => Promise<Record<string, string | undefined>>;
  openSession: (input: OpenSessionInput) => Promise<RunSession>;
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
}) {
  const container = createContainer<AppCradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });
  container.register({
    repoRoot: asValue(input.repoRoot),
    environment: asValue(input.environment),
    logFormat: asValue(input.logFormat),
    logLevel: asValue(input.logLevel ?? 'info'),
    config: asFunction(({ repoRoot }: AppCradle) => loadConfig(repoRoot)).singleton(),
    settings: asFunction(({ config }: AppCradle) => runSettingsFrom(config)).singleton(),
    logger: asFunction(({ logFormat, logLevel }: AppCradle) =>
      createConsoleLogger(logFormat, logLevel),
    ).singleton(),
    clock: asValue({ now: () => Date.now() }),
    artefacts: asFunction(({ repoRoot }: AppCradle) => new RunArtefacts(repoRoot)).singleton(),
    images: asFunction(
      ({ logger, environment }: AppCradle) =>
        new DockerImages({
          cache: environment.imageCache,
          onOutput: (line) => logger.debug(line.trimEnd()),
        }),
    ).singleton(),
    latestVersions: asValue(latestAgentVersions),
    openSession: asFunction((cradle: AppCradle) => sandcastleOpener(cradle)).singleton(),
  });
  return container;
}

/**
 * Starts the run's sandbox, builds everything scoped to the run and hands `use` what the engine
 * needs. The sandbox is closed and the scope disposed afterwards, however `use` ends.
 */
export async function withRunScope<T>(
  app: AwilixContainer<AppCradle>,
  { runId, baseBranch }: RunIdentity,
  runStore: RunStore,
  options: { tracer?: Tracer },
  use: (dependencies: EngineDependencies) => Promise<T>,
): Promise<T> {
  const scope = await openRunScope(app, { runId, baseBranch }, runStore, options);
  try {
    return await use(scope.cradle.engineDependencies);
  } finally {
    await closeRunScope(scope);
  }
}

async function openRunScope(
  app: AwilixContainer<AppCradle>,
  run: RunIdentity,
  runStore: RunStore,
  options: { tracer?: Tracer },
): Promise<AwilixContainer<RunCradle>> {
  const { repoRoot } = app.cradle;
  const scope = app.createScope<RunCradle>();
  scope.register({
    run: asValue(run),
    runStore: asValue(runStore),
    runLogger: asFunction(({ logFormat, logLevel }: RunCradle) =>
      createRunLogger(
        logFormat,
        // TODO(cohesion-14): 'run.log' and 'agents.log' name files in the state directory here, 'metrics.jsonl' in MetricsLog; let run-paths.ts name them all.
        path.join(stateDirectory(repoRoot, run.runId), 'run.log'),
        logLevel,
      ).child({
        runId: run.runId,
      }),
    ).scoped(),
    metricsLog: asFunction(() => new MetricsLog(repoRoot, run.runId)).scoped(),
    events: asFunction(({ runLogger, metricsLog, clock }: RunCradle) => {
      const events = new RunEvents();
      const onObserverError = (error: unknown) =>
        runLogger.warn({ err: error }, 'an observer failed');
      const logging = new LoggingObserver(runLogger);
      const metrics = new MetricsObserver((record) => metricsLog.append(record), clock);
      observe(events, (event) => logging.handle(event), onObserverError);
      observe(events, (event) => metrics.handle(event), onObserverError);
      if (options.tracer) {
        const tracing = new TracingObserver(options.tracer);
        observe(events, (event) => tracing.handle(event), onObserverError);
      }
      return events;
    }).scoped(),
  });

  const session = await openSessionRetrying(scope.cradle);
  scope.register({
    session: asValue(session),
    workspace: asFunction(
      () => new GitWorkspace({ repoRoot, worktreePath: session.worktreePath, ...run }),
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
  return scope;
}

/**
 * A sandbox that failed to start for a reason that may pass — Docker, the network under the
 * setup command — gets the same bounded retries as a step; a configuration problem does not.
 */
function openSessionRetrying({ openSession, run, events, settings, runLogger }: RunCradle) {
  return pRetry(() => openSession({ run, events }), {
    retries: settings.maxStepRetries,
    minTimeout: settings.retryDelayMs,
    shouldRetry: ({ error }) => isTransient(error),
    onFailedAttempt: ({ error, attemptNumber }) =>
      runLogger.warn({ err: error, attempt: attemptNumber }, 'the sandbox did not start'),
  });
}

/** Awilix's `dispose` alone would leave the sandbox running, so the session is closed first. */
async function closeRunScope(scope: AwilixContainer<RunCradle>) {
  try {
    await scope.cradle.session.close();
  } finally {
    await scope.dispose();
  }
}

function sandcastleOpener({
  repoRoot,
  config,
  environment,
  logger,
}: Pick<AppCradle, 'repoRoot' | 'config' | 'environment' | 'logger'>) {
  return async (input: OpenSessionInput): Promise<RunSession> => {
    // TODO(cohesion-10): the .sandcastle/.env warning is a sandbox rule; move it into adapters/sandcastle with the session options (cohesion-9).
    const injected = await sandcastleEnvKeys(repoRoot);
    if (injected.length > 0) {
      logger.warn(
        `.sandcastle/.env also puts ${injected.join(', ')} into the sandbox — jig passes credentials from the environment; remove the file unless the agents need these`,
      );
    }
    return SandcastleSession.open(sandcastleSessionOptions(repoRoot, config, input, environment));
  };
}

// TODO(cohesion-9): translating config and environment into sandcastle options is adapter knowledge; move it with agentsFor to adapters/sandcastle (pass the image name in, or move sandboxImageName down to adapters/sandbox-image).
/** What the run's sandbox is started with: the configured agents, their credentials and limits. */
export function sandcastleSessionOptions(
  repoRoot: string,
  config: JigConfig,
  { run, events, setupCommand }: OpenSessionInput,
  environment: JigEnvironment,
): SandcastleSessionOptions {
  const steps = configuredSteps(config);
  return {
    repoRoot,
    ...run,
    imageName: sandboxImageName(repoRoot, config),
    codexAuthDirectory: Object.values(steps).some((step) => step.provider === 'codex')
      ? environment.codexAuthDirectory
      : undefined,
    credentials: {
      ...collectCredentials(Object.values(steps), environment.credential),
      ...sandboxTelemetryEnvironment(environment.telemetry),
    },
    agents: agentsFor(steps),
    skipCommitSigning: config.commitSigning === 'skip',
    setupCommand: setupCommand === null ? undefined : (setupCommand ?? config.setupCommand),
    setupTimeoutSeconds: config.setupTimeoutSeconds,
    idleTimeoutSeconds: config.agentIdleTimeoutSeconds,
    agentLogFile: path.join(stateDirectory(repoRoot, run.runId), 'agents.log'),
    events,
  };
}

function agentsFor(steps: ReturnType<typeof configuredSteps>): Record<AgentRole, AgentProvider> {
  return byRole((role) => AGENTS[steps[role].provider].create(steps[role].model));
}
