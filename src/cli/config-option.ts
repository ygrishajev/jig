import { Option } from 'commander';
import { z } from 'zod';

import { type PresetName, presetNameSchema } from '../config/presets.js';

export type PresetSelection = { kind: 'named'; name: PresetName } | { kind: 'ask' };

/** The input of a command that reads the config; its input schema extends this one. */
export const configInputSchema = z.object({ config: z.string().min(1).optional() });

export function configOption(): Option {
  return new Option(
    '--config <path>',
    'config file to use instead of jig.config.json, e.g. a preset for this kind of run',
  );
}

/** Commander hands a bare `--preset` over as `true`, which here means "ask". */
const presetSelectionSchema = z.union([
  z.literal(true).transform((): PresetSelection => ({ kind: 'ask' })),
  presetNameSchema.transform((name): PresetSelection => ({ kind: 'named', name })),
]);

/** The input of a command that can swap in a preset's agents; its input schema extends this one. */
export const presetInputSchema = z.object({ preset: presetSelectionSchema.optional() });

export function presetOption(): Option {
  return new Option(
    '--preset [name]',
    "preset whose agents replace the config's; without a name, pick one from a list",
  );
}
