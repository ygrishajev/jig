import path from 'node:path';
import { asFunction, asValue, createContainer, InjectionMode, type AwilixContainer } from 'awilix';
import type { Logger } from 'pino';
import { DockerAgentSession } from '../adapters/docker-cli/docker-agent-session.js';
import type { AgentProvider } from '../adapters/docker-cli/types.js';
import { GitWorkspace } from '../adapters/git/git-workspace.js';
import { openRunWorktree } from '../adapters/git/run-worktree.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { stateDirectory } from '../adapters/local-store/run-paths.js';
import {
  createConsoleLogger,
  createRunLogger,
  type LogFormat,
} from '../adapters/logging/create-logger.js';
import { loadConfig, type SdlcConfig } from '../config/load-config.js';
import type { RunSettings } from '../domain/settings.js';
import type { EngineDependencies } from '../flow/engine.js';
import { LoggingObserver } from '../observers/logging-observer.js';
import { observe, RunEvents } from '../observers/run-events.js';
import type { AgentRole, AgentSession } from '../ports/agent-session.js';
import type { Clock } from '../ports/observability.js';
import type { Workspace } from '../ports/workspace.js';
import { buildAgentProviders } from './agent-providers.js';

/** How many times a step that failed transiently is tried again before the run blocks. */
const MAX_STEP_RETRIES = 2;

/** Long enough for a rate limit or a container hiccup to clear. */
const RETRY_DELAY_MS = 5000;

export interface RunIdentity {
  runId: string;
  baseBranch: string;
}

export interface AgentSessionOptions {
  worktreePath: string;
  repoRoot: string;
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
  agentProviders: Record<AgentRole, AgentProvider>;
  createAgentSession: (options: AgentSessionOptions) => AgentSession;
}

/** Lives for one run: its worktree, its sandbox, its log file. Disposed when the run stops. */
export interface RunCradle extends AppCradle {
  run: RunIdentity;
  worktreePath: string;
  runLogger: Logger;
  workspace: Workspace;
  agent: AgentSession;
  events: RunEvents;
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
    agentProviders: asFunction(({ config }: AppCradle) => buildAgentProviders(config)).singleton(),
    createAgentSession: asFunction(
      ({ agentProviders }: AppCradle) =>
        (options: AgentSessionOptions) =>
          new DockerAgentSession({ providers: agentProviders, ...options }),
    ).singleton(),
  });
  return container;
}

/** Opens a run's worktree and builds everything scoped to that run. Dispose the scope when done. */
export async function openRunScope(
  app: AwilixContainer<AppCradle>,
  run: RunIdentity,
): Promise<AwilixContainer<RunCradle>> {
  const { repoRoot, config } = app.cradle;
  const worktreePath = await openRunWorktree({
    repoRoot,
    ...run,
    skipCommitSigning: config.commitSigning === 'skip',
  });

  const scope = app.createScope<RunCradle>();
  scope.register({
    run: asValue(run),
    worktreePath: asValue(worktreePath),
    runLogger: asFunction(({ logFormat, logLevel }: RunCradle) =>
      createRunLogger(
        logFormat,
        path.join(stateDirectory(repoRoot, run.runId), 'run.log'),
        logLevel,
      ).child({
        runId: run.runId,
      }),
    ).scoped(),
    workspace: asFunction(
      ({ worktreePath: worktree }: RunCradle) =>
        new GitWorkspace({ repoRoot, worktreePath: worktree, ...run }),
    ).scoped(),
    agent: asFunction(({ createAgentSession, worktreePath: worktree }: RunCradle) =>
      createAgentSession({ worktreePath: worktree, repoRoot }),
    ).scoped(),
    events: asFunction(({ runLogger }: RunCradle) => {
      const events = new RunEvents();
      const logging = new LoggingObserver(runLogger);
      observe(
        events,
        (event) => logging.handle(event),
        (error) => runLogger.warn({ err: error }, 'an observer failed'),
      );
      return events;
    }).scoped(),
    engineDependencies: asFunction(
      ({ agent, workspace, store, events, clock, settings }: RunCradle): EngineDependencies => ({
        ports: { agent, workspace },
        store,
        events,
        clock,
        settings,
      }),
    ).scoped(),
  });
  return scope;
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
