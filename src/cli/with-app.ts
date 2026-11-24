import type { AwilixContainer } from 'awilix';
import { Result } from 'better-result';
import { homedir } from 'node:os';

import {
  type ConfigDestination,
  configDestination,
  configFileSource,
} from '../adapters/filesystem/config-source.js';
import {
  presetDirectoriesSource,
  type PresetLocations,
} from '../adapters/filesystem/preset-source.js';
import { ensureRepositoryRoot } from '../adapters/git/repository.js';
import { readCredentialsFile } from '../adapters/local-store/credentials-file.js';
import type { LogFormat } from '../adapters/logging/create-logger.js';
import { askForPreset } from '../adapters/terminal/ask-for-preset.js';
import { type AppCradle, createAppContainer } from '../app/container.js';
import { configWithSelectedPreset } from '../app/preset-selection.js';
import {
  prepareRepository,
  type RepositoryPreparationFailure,
  type RepositorySources,
} from '../app/repository-preparation.js';
import type { ConfigSource } from '../config/config-source.js';
import type { PresetSource } from '../config/preset-source.js';
import type { Preset, PresetPick, PresetSelection } from '../config/presets.js';

/** Where the CLI was started, what it was started with, and who answers its questions; the only reads of `process`. */
export interface Invocation {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  /** The operator's home directory as the OS reports it, used when `HOME` is unset. */
  fallbackHomeDirectory: string;
  askForPreset: (presets: Preset[]) => Promise<PresetPick | undefined>;
  createAppContainer: typeof createAppContainer;
  configSourceAt: (destination: ConfigDestination) => ConfigSource;
  presetSourceAt: (locations: PresetLocations) => PresetSource;
}

/** How the operator asked the command to run: how it logs, the config file it reads, and the preset over it. */
export interface AppOptions {
  logFormat: LogFormat;
  config?: string;
  preset?: PresetSelection;
}

/** Why the app could not open: the repository, the environment, the credentials file, the config or the preset. */
export type AppOpenFailure = RepositoryPreparationFailure;

/** Runs a command against the repository in the working directory, then releases what it opened. */
export async function withApp<T, E extends { message: string }>(
  options: AppOptions,
  command: (app: AwilixContainer<AppCradle>) => Promise<Result<T, E>>,
  invocation: Invocation = processInvocation(),
): Promise<Result<T, E | AppOpenFailure>> {
  const app = await openApp(options, invocation);
  if (app.isErr()) return Result.err(app.error);
  try {
    return await command(app.value);
  } finally {
    await app.value.dispose();
  }
}

export function processInvocation(): Invocation {
  return {
    cwd: process.cwd(),
    environment: process.env,
    fallbackHomeDirectory: homedir(),
    askForPreset,
    createAppContainer,
    configSourceAt: configFileSource,
    presetSourceAt: presetDirectoriesSource,
  };
}

function openApp(
  { logFormat, config: configPath, preset }: AppOptions,
  invocation: Invocation,
): Promise<Result<AwilixContainer<AppCradle>, AppOpenFailure>> {
  return Result.gen(async function* () {
    const prepared = yield* Result.await(
      prepareRepository(invocation, repositorySourcesOf(invocation), configPath),
    );
    const { repoRoot, environment, configSource, presetSource } = prepared;
    const { config, presetName } = yield* Result.await(
      configWithSelectedPreset(prepared, preset, invocation),
    );
    const app = invocation.createAppContainer({
      repoRoot,
      logFormat,
      environment,
      configDestination: configDestination(repoRoot, configPath),
      configSource,
      config,
      presetSource,
    });
    if (presetName !== undefined) {
      app.cradle.logger.info({ preset: presetName }, `Using preset ${presetName}`);
    }
    return Result.ok(app);
  });
}

function repositorySourcesOf({ configSourceAt, presetSourceAt }: Invocation): RepositorySources {
  return {
    ensureRepositoryRoot,
    readSavedCredentials: readCredentialsFile,
    configSourceFor: (repoRoot, configPath) =>
      configSourceAt(configDestination(repoRoot, configPath)),
    presetSourceFor: presetSourceAt,
  };
}
