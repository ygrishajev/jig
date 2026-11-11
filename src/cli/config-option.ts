import { Option } from 'commander';
import { z } from 'zod';

import { presetNameSchema } from '../config/presets.js';

/** The input of a command that reads the config; its input schema extends this one. */
export const configInputSchema = z.object({ config: z.string().min(1).optional() });

export function configOption(): Option {
  return new Option(
    '--config <path>',
    'config file to use instead of jig.config.json, e.g. a preset for this kind of run',
  );
}

/** The input of a command that can swap in a preset's agents; its input schema extends this one. */
export const presetInputSchema = z.object({ preset: presetNameSchema.optional() });

export function presetOption(): Option {
  return new Option(
    '--preset <name>',
    "preset whose agents replace the config's; jig presets lists them",
  );
}
