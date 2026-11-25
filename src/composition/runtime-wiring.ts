import type { Result } from 'better-result';
import type { Logger } from 'pino';

import { throwawayBranches } from '../adapters/git/throwaway-branches.js';
import { createConsoleLogger } from '../adapters/logging/create-logger.js';
import { DockerImages } from '../adapters/sandbox-image/docker-images.js';
import { latestAgentVersions } from '../adapters/sandbox-image/latest-agent-versions.js';
import {
  RepositoryImageRecipe,
  sandboxImageName,
} from '../adapters/sandbox-image/repository-image-recipe.js';
import {
  openSandcastleSession,
  type OpenSessionInput,
  type SandcastleContext,
} from '../adapters/sandcastle/open-session.js';
import type {
  EnsureImageDependencies,
  SandboxCapabilities,
  SandboxOpenFailure,
  ThrowawaySandboxes,
} from '../app/api.js';
import type { JigEnvironment } from '../config/environment.js';
import { type JigConfig, runSettingsFrom } from '../config/load-config.js';
import type { RunSettings } from '../domain/settings.js';
import { LoggingObserver } from '../observers/logging-observer.js';
import type { LogFormat } from '../ports/observability.js';
import type { RunSession } from '../ports/run-session.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import { observedEvents } from './observed-events.js';

/** The console log a runtime shares with every sandbox and run it opens. */
export interface ConsoleWiring {
  /** The level the console and every run's log write at. */
  readonly logLevel: string;
  consoleLog(format: LogFormat, level: string): Logger;
}

/** What a sandbox image is built and checked with. */
export interface ImageWiring {
  images(log: Logger, environment: JigEnvironment): SandboxImages;
  latestVersions(npmPackages: string[]): Promise<Record<string, string | undefined>>;
}

/** How a sandbox session is opened. */
export interface SessionWiring {
  openSession(
    context: SessionContext,
    input: OpenSessionInput,
  ): Promise<Result<RunSession, SandboxOpenFailure>>;
}

export type SessionContext = SandcastleContext & { logger: Logger };

/** The settings, retries included, a run's engine works under. */
export interface SettingsWiring {
  runSettings(config: JigConfig): RunSettings;
}

/** The repository, and the config and environment one sandbox is started with. */
export interface SandboxSetting {
  repoRoot: string;
  config: JigConfig;
  environment: JigEnvironment;
  log: Logger;
}

export const productionConsole: ConsoleWiring = {
  logLevel: 'info',
  consoleLog: (format, level) => createConsoleLogger(format, level),
};

export const productionImages: ImageWiring = {
  images: (log, environment) =>
    new DockerImages({
      cache: environment.imageCache,
      onOutput: (line) => log.debug(line.trimEnd()),
    }),
  latestVersions: latestAgentVersions,
};

export const productionSessions: SessionWiring = { openSession: openSandcastleSession };

export const productionSettings: SettingsWiring = { runSettings: runSettingsFrom };

export function sandboxCapabilities(
  wiring: ImageWiring & SessionWiring,
  setting: SandboxSetting,
): SandboxCapabilities {
  return {
    image: imageDependencies(wiring, setting),
    throwaway: throwawaySandboxes(wiring, setting),
  };
}

export function imageDependencies(
  { images, latestVersions }: ImageWiring,
  { repoRoot, config, environment, log }: SandboxSetting,
): EnsureImageDependencies {
  return {
    config,
    images: images(log, environment),
    recipe: new RepositoryImageRecipe(repoRoot, config),
    latestVersions,
    log,
  };
}

/** A throwaway sandbox's events are logged to the console. */
function throwawaySandboxes(
  { openSession }: SessionWiring,
  setting: SandboxSetting,
): ThrowawaySandboxes {
  const { repoRoot, log } = setting;
  return {
    ...throwawayBranches(repoRoot),
    log,
    open: (run, setupCommand) =>
      openSession(sessionContext(setting), {
        run,
        events: observedEvents(log, [new LoggingObserver(log)]),
        setupCommand,
      }),
  };
}

export function sessionContext({
  repoRoot,
  config,
  environment,
  log,
}: SandboxSetting): SessionContext {
  return {
    repoRoot,
    config,
    environment,
    logger: log,
    imageName: sandboxImageName(repoRoot, config),
  };
}
