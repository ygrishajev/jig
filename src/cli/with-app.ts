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
import { askForPreset, type PresetPick } from '../adapters/terminal/ask-for-preset.js';
import { processStandardInput, type StandardInput } from '../adapters/terminal/standard-input.js';
import { type AppCradle, createAppContainer } from '../app/container.js';
import type { ConfigSource } from '../config/config-source.js';
import { parseEnvironment, withCredentials } from '../config/environment.js';
import { loadConfig } from '../config/load-config.js';
import type { PresetSource } from '../config/preset-source.js';
import {
  configWithPreset,
  discoverPresets,
  type Preset,
  type PresetName,
} from '../config/presets.js';
import { ConfigInvalid, type JigError } from '../domain/errors.js';
import type { PresetSelection } from './config-option.js';

/** Where the CLI was started, what it was started with, and who answers its questions; the only reads of `process`. */
export interface Invocation {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  /** The operator's home directory as the OS reports it, used when `HOME` is unset. */
  fallbackHomeDirectory: string;
  askForPreset: (presets: Preset[]) => Promise<PresetPick | undefined>;
  createAppContainer: typeof createAppContainer;
  configSourceAt: (destination: ConfigDestination) => ConfigSource;
  standardInput: StandardInput;
  presetSourceAt: (locations: PresetLocations) => PresetSource;
}

/** How the operator asked the command to run: how it logs, the config file it reads, and the preset over it. */
export interface AppOptions {
  logFormat: LogFormat;
  config?: string;
  preset?: PresetSelection;
}

/** Runs a command against the repository in the working directory, then releases what it opened. */
export async function withApp<T, E extends { message: string }>(
  options: AppOptions,
  command: (app: AwilixContainer<AppCradle>) => Promise<Result<T, E>>,
  invocation: Invocation = processInvocation(),
): Promise<Result<T, E | JigError>> {
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
    standardInput: processStandardInput(),
    presetSourceAt: presetDirectoriesSource,
  };
}

function openApp(
  { logFormat, config: configPath, preset }: AppOptions,
  {
    cwd,
    environment,
    fallbackHomeDirectory,
    askForPreset: ask,
    createAppContainer: createApp,
    configSourceAt,
    presetSourceAt,
  }: Invocation,
): Promise<Result<AwilixContainer<AppCradle>, JigError>> {
  return Result.gen(async function* () {
    yield* Result.await(ensureRepositoryRoot(cwd));
    const parsedEnvironment = yield* parseEnvironment(environment, fallbackHomeDirectory);
    const savedCredentials = yield* readCredentialsFile(cwd);
    const jigEnvironment = withCredentials(parsedEnvironment, savedCredentials);
    const destination = configDestination(cwd, configPath);
    const configSource = configSourceAt(destination);
    const projectConfig = yield* loadConfig(configSource);
    const presetSource = presetSourceAt({ repoRoot: cwd, ...jigEnvironment });
    const presetName = yield* Result.await(selectedPreset(preset, presetSource, ask));
    const config = yield* configWithPreset(projectConfig, presetSource, presetName);
    const app = createApp({
      repoRoot: cwd,
      logFormat,
      environment: jigEnvironment,
      configDestination: destination,
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

function selectedPreset(
  selection: PresetSelection | undefined,
  source: PresetSource,
  ask: Invocation['askForPreset'],
): Promise<Result<PresetName | undefined, ConfigInvalid>> {
  return Result.gen(async function* () {
    if (selection?.kind !== 'ask') return Result.ok(selection?.name);
    const presets = yield* discoverPresets(source);
    const pick = presets.length > 0 ? await ask(presets) : undefined;
    if (pick === undefined) {
      return Result.err(
        new ConfigInvalid({
          message: 'No preset was picked — pass --preset <name>; jig presets lists them.',
        }),
      );
    }
    return Result.ok(pick.kind === 'preset' ? pick.name : undefined);
  });
}
