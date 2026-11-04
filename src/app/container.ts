import type { Tracer } from '@opentelemetry/api';
import { asFunction, asValue, type AwilixContainer, createContainer, InjectionMode } from 'awilix';
import { Result } from 'better-result';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';

import { GitWorkspace } from '../adapters/git/git-workspace.js';
import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { RunArtefacts } from '../adapters/local-store/run-artefacts.js';
import { runLogFile } from '../adapters/local-store/run-paths.js';
import {
  createConsoleLogger,
  createRunLogger,
  type LogFormat,
} from '../adapters/logging/create-logger.js';
import { DockerImages } from '../adapters/sandbox-image/docker-images.js';
import { latestAgentVersions } from '../adapters/sandbox-image/latest-agent-versions.js';
import {
  openSandcastleSession,
  type OpenSessionInput,
} from '../adapters/sandcastle/open-session.js';
import type {
  SessionCloseFailure,
  SessionOpenFailure,
} from '../adapters/sandcastle/sandcastle-session.js';
import type { JigEnvironment } from '../config/environment.js';
import { type JigConfig, runSettingsFrom } from '../config/load-config.js';
import { type GitCommandFailed, isTransient, type JigError } from '../domain/errors.js';
import type { RunEvent } from '../domain/events.js';
import { retryResult } from '../domain/retry.js';
import { runIdSchema } from '../domain/run-id.js';
import { runBranchFor, type RunIdentity } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { EngineDependencies } from '../flow/engine.js';
import { deleteBranch, getCurrentBranch } from '../git/branch.js';
import { LoggingObserver } from '../observers/logging-observer.js';
import { MetricsObserver } from '../observers/metrics.js';
import { observe, RunEvents } from '../observers/run-events.js';
import { TracingObserver } from '../observers/tracing-observer.js';
import type { AgentSession } from '../ports/agent-session.js';
import type { Clock } from '../ports/observability.js';
import type { RunStore } from '../ports/run-store.js';
import type { SandboxGit } from '../ports/sandbox-git.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import type { Workspace } from '../ports/workspace.js';
import { sandboxImageName } from './sandbox-image.js';

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
  config: JigConfig;
  settings: RunSettings;
  logger: Logger;
  clock: Clock;
  artefacts: RunArtefacts;
  images: SandboxImages;
  latestVersions: (npmPackages: string[]) => Promise<Record<string, string | undefined>>;
  openSession: (input: OpenSessionInput) => Promise<Result<RunSession, SessionOpenFailure>>;
}

/** The run's sandbox: where agents and commands run, and the host worktree of the run branch. */
export interface RunSession extends AgentSession, SandboxGit {
  readonly worktreePath: string;
  close(): Promise<Result<void, SessionCloseFailure>>;
}

export function createAppContainer(input: {
  repoRoot: string;
  logFormat: LogFormat;
  logLevel?: string;
  environment: JigEnvironment;
  config: JigConfig;
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
    config: asValue(input.config),
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
      ({ workspace, runStore: store, events, clock, settings }: RunCradle): EngineDependencies => ({
        ports: { agent: session, workspace },
        store,
        events,
        clock,
        settings,
      }),
    ).scoped(),
  });
  return Result.ok(scope);
}

/** Events the given observers hear; one that fails is logged, and the others still hear the event. */
function observedEvents(logger: Logger, observers: { handle(event: RunEvent): void }[]): RunEvents {
  const events = new RunEvents();
  const onObserverError = (error: unknown): void =>
    logger.warn({ err: error }, 'an observer failed');
  for (const observer of observers) {
    observe(events, (event) => observer.handle(event), onObserverError);
  }
  return events;
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
    retries: settings.maxStepRetries,
    delayMs: settings.retryDelayMs,
    shouldRetry: isTransient,
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

/** A failed cleanup is the outcome only when the work itself succeeded; otherwise it is logged. */
function reportCleanup<T, E, C extends JigError>(
  used: Result<T, E>,
  cleanup: Result<void, C>,
  logger: Logger,
): Result<T, E | C> {
  if (cleanup.isOk()) return used;
  if (used.isOk()) return Result.err(cleanup.error);
  logger.warn({ err: cleanup.error }, 'cleanup failed after the run failed');
  return used;
}

/**
 * A sandbox for a one-off check, on a branch of its own that is removed afterwards, its events
 * logged to the console. It is never retried: a setup command that fails is the answer the
 * caller is waiting for, not a hiccup.
 */
export async function withThrowawaySandbox<T, E>(
  app: AwilixContainer<AppCradle>,
  setupCommand: string | null,
  use: (session: RunSession) => Promise<Result<T, E>>,
): Promise<Result<T, E | SessionOpenFailure | SessionCloseFailure | GitCommandFailed>> {
  const { repoRoot, logger, openSession } = app.cradle;
  const baseBranch = await getCurrentBranch(repoRoot);
  if (baseBranch.isErr()) return Result.err(baseBranch.error);
  const run: RunIdentity = {
    runId: runIdSchema.parse(`init-${randomBytes(3).toString('hex')}`),
    baseBranch: baseBranch.value,
  };
  const events = observedEvents(logger, [new LoggingObserver(logger)]);
  const session = await openSession({ run, events, setupCommand });
  if (session.isErr()) return Result.err(session.error);
  let used: Result<T, E>;
  let closed: Result<void, SessionCloseFailure>;
  let deleted: Result<void, GitCommandFailed>;
  try {
    used = await use(session.value);
  } finally {
    closed = await session.value.close();
    deleted = await deleteBranch(repoRoot, runBranchFor(run.runId));
  }
  if (closed.isErr() && deleted.isErr()) {
    logger.warn({ err: deleted.error }, 'removing the throwaway branch failed as well');
  }
  const cleaned: Result<void, SessionCloseFailure | GitCommandFailed> = closed.isErr()
    ? closed
    : deleted;
  return reportCleanup(used, cleaned, logger);
}
