import type { AwilixContainer } from 'awilix';
import { Result } from 'better-result';

import { ensureRepositoryRoot } from '../adapters/git/repository.js';
import { readCredentialsFile } from '../adapters/local-store/credentials-file.js';
import type { LogFormat } from '../adapters/logging/create-logger.js';
import { askForPreset, type PresetPick } from '../adapters/terminal/ask-for-preset.js';
import { processStandardInput, type StandardInput } from '../adapters/terminal/standard-input.js';
import { type AppCradle, createAppContainer } from '../app/container.js';
import { parseEnvironment, withCredentials } from '../config/environment.js';
import { configFileFor, loadConfig } from '../config/load-config.js';
import {
  configWithPreset,
  discoverPresets,
  type Preset,
  type PresetLocations,
  type PresetName,
} from '../config/presets.js';
import { ConfigInvalid, type JigError } from '../domain/errors.js';
import type { PresetSelection } from './config-option.js';

/** Where the CLI was started, what it was started with, and who answers its questions; the only reads of `process`. */
export interface Invocation {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  askForPreset: (presets: Preset[]) => Promise<PresetPick | undefined>;
  createAppContainer: typeof createAppContainer;
  standardInput: StandardInput;
  /** The starters' folder; the package's own unless a spec points elsewhere. */
  builtinPresetsDirectory?: string;
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
    askForPreset,
    createAppContainer,
    standardInput: processStandardInput(),
  };
}

function openApp(
  { logFormat, config: configPath, preset }: AppOptions,
  {
    cwd,
    environment,
    askForPreset: ask,
    createAppContainer: createApp,
    builtinPresetsDirectory,
  }: Invocation,
): Promise<Result<AwilixContainer<AppCradle>, JigError>> {
  return Result.gen(async function* () {
    yield* Result.await(ensureRepositoryRoot(cwd));
    const parsedEnvironment = yield* parseEnvironment(environment);
    const savedCredentials = yield* readCredentialsFile(cwd);
    const jigEnvironment = withCredentials(parsedEnvironment, savedCredentials);
    const configFile = configFileFor(cwd, configPath);
    const projectConfig = yield* loadConfig(configFile);
    const presetLocations = {
      repoRoot: cwd,
      builtinDirectory: builtinPresetsDirectory,
      ...jigEnvironment,
    };
    const presetName = yield* Result.await(selectedPreset(preset, presetLocations, ask));
    const config = yield* configWithPreset(projectConfig, presetLocations, presetName);
    const app = createApp({
      repoRoot: cwd,
      logFormat,
      environment: jigEnvironment,
      configFile,
      config,
    });
    if (presetName !== undefined) {
      app.cradle.logger.info({ preset: presetName }, `Using preset ${presetName}`);
    }
    return Result.ok(app);
  });
}

function selectedPreset(
  selection: PresetSelection | undefined,
  locations: PresetLocations,
  ask: Invocation['askForPreset'],
): Promise<Result<PresetName | undefined, ConfigInvalid>> {
  return Result.gen(async function* () {
    if (selection?.kind !== 'ask') return Result.ok(selection?.name);
    const presets = yield* discoverPresets(locations);
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
