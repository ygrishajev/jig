import { Option } from 'commander';
import { z } from 'zod';

/** The input of a command that reads the config; its input schema extends this one. */
export const configInputSchema = z.object({ config: z.string().min(1).optional() });

export function configOption(): Option {
  return new Option(
    '--config <path>',
    'config file to use instead of jig.config.json, e.g. a preset for this kind of run',
  );
}
