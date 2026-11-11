import type { AwilixContainer } from 'awilix';
import { Result } from 'better-result';

import { readCredentialsFile } from '../adapters/local-store/credentials-file.js';
import type { LogFormat } from '../adapters/logging/create-logger.js';
import { askForPreset, type PresetPick } from '../adapters/terminal/ask-for-preset.js';
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
import { ensureRepositoryRoot } from '../git/repository.js';
import type { PresetSelection } from './config-option.js';

/** Where the CLI was started, what it was started with, and who answers its questions; the only reads of `process`. */
export interface Invocation {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  askForPreset: (presets: Preset[]) => Promise<PresetPick | undefined>;
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
export async function withApp<T>(
  { logFormat, config: configPath, preset }: AppOptions,
  command: (app: AwilixContainer<AppCradle>) => Promise<Result<T, JigError>>,
  { cwd, environment, askForPreset: ask, builtinPresetsDirectory }: Invocation = {
    cwd: process.cwd(),
    environment: process.env,
    askForPreset,
  },
): Promise<Result<T, JigError>> {
  const root = await ensureRepositoryRoot(cwd);
  if (root.isErr()) return Result.err(root.error);
  const parsedEnvironment = parseEnvironment(environment);
  if (parsedEnvironment.isErr()) return Result.err(parsedEnvironment.error);
  const savedCredentials = readCredentialsFile(cwd);
  if (savedCredentials.isErr()) return Result.err(savedCredentials.error);
  const jigEnvironment = withCredentials(parsedEnvironment.value, savedCredentials.value);
  const configFile = configFileFor(cwd, configPath);
  const projectConfig = loadConfig(configFile);
  if (projectConfig.isErr()) return Result.err(projectConfig.error);
  const presetLocations = {
    repoRoot: cwd,
    builtinDirectory: builtinPresetsDirectory,
    ...jigEnvironment,
  };
  const presetName = await selectedPreset(preset, presetLocations, ask);
  if (presetName.isErr()) return Result.err(presetName.error);
  const config = configWithPreset(projectConfig.value, presetLocations, presetName.value);
  if (config.isErr()) return Result.err(config.error);
  const app = createAppContainer({
    repoRoot: cwd,
    logFormat,
    environment: jigEnvironment,
    configFile,
    config: config.value,
  });
  try {
    return await command(app);
  } finally {
    await app.dispose();
  }
}

/** The preset the operator named or picked; `undefined` for the project's config alone. */
async function selectedPreset(
  selection: PresetSelection | undefined,
  locations: PresetLocations,
  ask: Invocation['askForPreset'],
): Promise<Result<PresetName | undefined, ConfigInvalid>> {
  if (selection === undefined) return Result.ok(undefined);
  if (selection.kind === 'named') return Result.ok(selection.name);
  const presets = discoverPresets(locations);
  if (presets.isErr()) return Result.err(presets.error);
  const pick = presets.value.length > 0 ? await ask(presets.value) : undefined;
  if (pick === undefined) {
    return Result.err(
      new ConfigInvalid({
        message: 'No preset was picked — pass --preset <name>; jig presets lists them.',
      }),
    );
  }
  return Result.ok(pick.kind === 'preset' ? pick.name : undefined);
}
