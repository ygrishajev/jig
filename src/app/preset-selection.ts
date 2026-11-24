import { Result } from 'better-result';

import { ConfigInvalid } from '../config/errors.js';
import type { JigConfig } from '../config/load-config.js';
import {
  configWithPreset,
  discoverPresets,
  type Preset,
  type PresetName,
  type PresetPick,
  type PresetSelection,
} from '../config/presets.js';
import {
  type OperationContext,
  type PreparedRepository,
  prepareRepository,
  type RepositoryPreparationFailure,
  type RepositorySources,
} from './repository-preparation.js';

/** What an operation that may run under a preset prepares its repository with. */
export interface PresetPreparation extends RepositorySources, PresetChooser {
  context(): OperationContext;
}

/** Asks the operator which preset to use; nobody answering is `undefined`. */
export interface PresetChooser {
  askForPreset(presets: Preset[]): Promise<PresetPick | undefined>;
}

/** A prepared repository whose config has the preset applied, and that preset's name, when one was. */
export interface PresetRepository {
  repository: PreparedRepository;
  presetName?: PresetName;
}

/** The config an operation runs with, and the preset that replaced its agents, when one did. */
export interface PresetConfig {
  config: JigConfig;
  presetName?: PresetName;
}

/**
 * Prepares the repository the operation runs in, then applies the preset it was asked for, so a
 * refusal of either comes before anything is built.
 */
export function prepareWithPreset(
  capabilities: PresetPreparation,
  { configPath, preset }: { configPath?: string; preset?: PresetSelection },
): Promise<Result<PresetRepository, RepositoryPreparationFailure | ConfigInvalid>> {
  return Result.gen(async function* () {
    const prepared = yield* Result.await(
      prepareRepository(capabilities.context(), capabilities, configPath),
    );
    const { config, presetName } = yield* Result.await(
      configWithSelectedPreset(prepared, preset, capabilities),
    );
    return Result.ok({ repository: { ...prepared, config }, presetName });
  });
}

/**
 * Applies the preset the operation was asked for. A bare `--preset` asks the operator to pick
 * one, and a pick nobody made refuses the operation rather than running without the preset.
 */
export function configWithSelectedPreset(
  { config, presetSource }: Pick<PreparedRepository, 'config' | 'presetSource'>,
  selection: PresetSelection | undefined,
  chooser: PresetChooser,
): Promise<Result<PresetConfig, ConfigInvalid>> {
  return Result.gen(async function* () {
    const presetName = yield* Result.await(selectedPreset(selection, presetSource, chooser));
    const presetConfig = yield* configWithPreset(config, presetSource, presetName);
    return Result.ok({ config: presetConfig, presetName });
  });
}

function selectedPreset(
  selection: PresetSelection | undefined,
  source: PreparedRepository['presetSource'],
  chooser: PresetChooser,
): Promise<Result<PresetName | undefined, ConfigInvalid>> {
  return Result.gen(async function* () {
    if (selection?.kind !== 'ask') return Result.ok(selection?.name);
    const presets = yield* discoverPresets(source);
    const pick = presets.length > 0 ? await chooser.askForPreset(presets) : undefined;
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
