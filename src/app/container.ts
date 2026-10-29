import path from 'node:path';
import type { AgentProvider } from '@ai-hero/sandcastle';
import { asFunction, asValue, createContainer, InjectionMode, type AwilixContainer } from 'awilix';
import type { Tracer } from '@opentelemetry/api';
import type { Logger } from 'pino';
import { GitWorkspace } from '../adapters/git/git-workspace.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { stateDirectory } from '../adapters/local-store/run-paths.js';
import {
  createConsoleLogger,
  createRunLogger,
  type LogFormat,
} from '../adapters/logging/create-logger.js';
import { DockerImages } from '../adapters/sandbox-image/docker-images.js';
import { latestAgentVersions } from '../adapters/sandbox-image/latest-agent-versions.js';
import { AGENTS, collectCredentials } from '../adapters/sandcastle/agents.js';
import { SandcastleSession } from '../adapters/sandcastle/sandcastle-session.js';
import { sandboxTelemetryEnvironment } from '../adapters/telemetry/open-telemetry.js';
import { configuredSteps, loadConfig, type SdlcConfig } from '../config/load-config.js';
import type { AgentRole } from '../domain/agent-role.js';
import type { RunSettings } from '../domain/settings.js';
import type { EngineDependencies } from '../flow/engine.js';
import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { LoggingObserver } from '../observers/logging-observer.js';
import { MetricsObserver } from '../observers/metrics.js';
import { TracingObserver } from '../observers/tracing-observer.js';
import { observe, RunEvents } from '../observers/run-events.js';
import type { AgentSession } from '../ports/agent-session.js';
import type { Clock, EventSink } from '../ports/observability.js';
import type { RunStore } from '../ports/run-store.js';
import type { Workspace } from '../ports/workspace.js';
import { sandboxImageName } from './sandbox-image.js';

/** How many times a step that failed transiently is tried again before the run blocks. */
const MAX_STEP_RETRIES = 2;

/** Long enough for a rate limit or a container hiccup to clear. */
const RETRY_DELAY_MS = 5000;

export interface RunIdentity {
  runId: string;
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
  logFormat: LogFormat;
  logLevel: string;
  config: SdlcConfig;
  settings: RunSettings;
  logger: Logger;
  clock: Clock;
  store: LocalRunStore;
  images: DockerImages;
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
}) {
  const container = createContainer<AppCradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });
  container.register({
    repoRoot: asValue(input.repoRoot),
    logFormat: asValue(input.logFormat),
    logLevel: asValue(input.logLevel ?? 'info'),
    config: asFunction(({ repoRoot }: AppCradle) => loadConfig(repoRoot)).singleton(),
    settings: asFunction(({ config }: AppCradle) => settingsFrom(config)).singleton(),
    logger: asFunction(({ logFormat, logLevel }: AppCradle) =>
      createConsoleLogger(logFormat, logLevel),
    ).singleton(),
    clock: asValue({ now: () => Date.now() }),
    store: asFunction(({ repoRoot }: AppCradle) => new LocalRunStore(repoRoot)).singleton(),
    images: asFunction(
      ({ logger }: AppCradle) =>
        new DockerImages({
          cache: process.env.SDLC_IMAGE_CACHE === 'gha' ? 'gha' : undefined,
          onOutput: (line) => logger.debug(line.trimEnd()),
        }),
    ).singleton(),
    latestVersions: asValue(latestAgentVersions),
    openSession: asFunction(({ repoRoot, config }: AppCradle) =>
      sandcastleOpener(repoRoot, config),
    ).singleton(),
  });
  return container;
}

/** Starts the run's sandbox and builds everything scoped to the run. Dispose the scope when done. */
export async function openRunScope(
  app: AwilixContainer<AppCradle>,
  run: RunIdentity,
  runStore: RunStore,
  options: { tracer?: Tracer } = {},
): Promise<AwilixContainer<RunCradle>> {
  const { repoRoot } = app.cradle;
  const scope = app.createScope<RunCradle>();
  scope.register({
    run: asValue(run),
    runStore: asValue(runStore),
    runLogger: asFunction(({ logFormat, logLevel }: RunCradle) =>
      createRunLogger(
        logFormat,
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

  const session = await app.cradle.openSession({ run, events: scope.cradle.events });
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

/** Closes the run's sandbox and then the rest of its scope. */
export async function closeRunScope(scope: AwilixContainer<RunCradle>) {
  try {
    await scope.cradle.session.close();
  } finally {
    await scope.dispose();
  }
}

function sandcastleOpener(repoRoot: string, config: SdlcConfig) {
  return async ({ run, events, setupCommand }: OpenSessionInput): Promise<RunSession> => {
    const steps = configuredSteps(config);
    return SandcastleSession.open({
      repoRoot,
      ...run,
      imageName: sandboxImageName(repoRoot, config),
      credentials: {
        ...collectCredentials(Object.values(steps), process.env),
        ...sandboxTelemetryEnvironment(process.env),
      },
      agents: agentsFor(steps),
      skipCommitSigning: config.commitSigning === 'skip',
      setupCommand: setupCommand === null ? undefined : (setupCommand ?? config.setupCommand),
      setupTimeoutSeconds: config.setupTimeoutSeconds,
      idleTimeoutSeconds: config.agentIdleTimeoutSeconds,
      agentLogFile: path.join(stateDirectory(repoRoot, run.runId), 'agents.log'),
      events,
    });
  };
}

function agentsFor(steps: ReturnType<typeof configuredSteps>): Record<AgentRole, AgentProvider> {
  const agentFor = (role: AgentRole) => AGENTS[steps[role].provider].create(steps[role].model);
  return {
    planner: agentFor('planner'),
    implementer: agentFor('implementer'),
    reviewer: agentFor('reviewer'),
    describer: agentFor('describer'),
  };
}

function settingsFrom(config: SdlcConfig): RunSettings {
  return {
    reviewCycleCap: config.reviewCycleCap,
    maxStepRetries: MAX_STEP_RETRIES,
    retryDelayMs: RETRY_DELAY_MS,
    designGate: config.designGate,
    mergeMode: config.mergeMode,
    verifyCommand: config.verifyCommand,
  };
}
