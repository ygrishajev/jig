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
import type { PreparedRepository } from './repository-preparation.js';

/** Asks the operator which preset to use; nobody answering is `undefined`. */
export interface PresetChooser {
  askForPreset(presets: Preset[]): Promise<PresetPick | undefined>;
}

/** The config an operation runs with, and the preset that replaced its agents, when one did. */
export interface PresetConfig {
  config: JigConfig;
  presetName?: PresetName;
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
