import { Result } from 'better-result';

import type { ConfigSource } from '../config/config-source.js';
import { type JigEnvironment, parseEnvironment, withCredentials } from '../config/environment.js';
import type { ConfigInvalid } from '../config/errors.js';
import { type JigConfig, loadConfig } from '../config/load-config.js';
import type { PresetSource } from '../config/preset-source.js';
import type { RepositoryInvalid } from '../ports/git-failures.js';
import type { LocalPreparationFailed } from '../ports/local-state.js';

/** Where an operation was asked to run and the environment it was asked with, as the caller captured them. */
export interface OperationContext {
  cwd: string;
  environment: EnvironmentVariables;
  /** The operator's home directory as the OS reports it, used when `HOME` is unset. */
  fallbackHomeDirectory: string;
}

export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/** What an operation reads a repository's settings through; each is called only once the operation runs. */
export interface RepositorySources {
  ensureRepositoryRoot(directory: string): Promise<Result<void, RepositoryInvalid>>;
  /** The credentials the operator saved for this repository at `jig init`. */
  readSavedCredentials(repoRoot: string): Result<Record<string, string>, LocalPreparationFailed>;
  /** The repository's own settings, or the file `configPath` names relative to its root. */
  configSourceFor(repoRoot: string, configPath: string | undefined): ConfigSource;
  presetSourceFor(places: PresetPlaces): PresetSource;
}

/** What the preset directories are found under: the repository, the operator's home and their XDG config home. */
export interface PresetPlaces extends Pick<JigEnvironment, 'homeDirectory' | 'xdgConfigHome'> {
  repoRoot: string;
}

/** A repository an operation may work in, with its environment, settings and presets read. */
export interface PreparedRepository {
  repoRoot: string;
  environment: JigEnvironment;
  configSource: ConfigSource;
  config: JigConfig;
  presetSource: PresetSource;
}

/** Why a repository could not be prepared: it is not one, or its environment, credentials file or config is unusable. */
export type RepositoryPreparationFailure =
  RepositoryInvalid | ConfigInvalid | LocalPreparationFailed;

/**
 * Refuses a directory below a repository's root before reading anything from it, then reads the
 * environment, the saved credentials under it and the config. A variable in the environment
 * wins over a saved credential of the same name. Nothing is prompted for and nothing is opened.
 */
export function prepareRepository(
  { cwd, environment, fallbackHomeDirectory }: OperationContext,
  sources: RepositorySources,
  configPath?: string,
): Promise<Result<PreparedRepository, RepositoryPreparationFailure>> {
  return Result.gen(async function* () {
    yield* Result.await(sources.ensureRepositoryRoot(cwd));
    const parsedEnvironment = yield* parseEnvironment(environment, fallbackHomeDirectory);
    const savedCredentials = yield* sources.readSavedCredentials(cwd);
    const jigEnvironment = withCredentials(parsedEnvironment, savedCredentials);
    const configSource = sources.configSourceFor(cwd, configPath);
    const config = yield* loadConfig(configSource);
    const presetSource = sources.presetSourceFor({ repoRoot: cwd, ...jigEnvironment });
    return Result.ok({
      repoRoot: cwd,
      environment: jigEnvironment,
      configSource,
      config,
      presetSource,
    });
  });
}
