import { Option } from 'commander';
import { z } from 'zod';

import { type LogFormat, logFormatSchema } from '../ports/observability.js';

/** The input of a command that takes `--log-format`; its input schema extends this one. */
export const logFormatInputSchema = z.object({ logFormat: logFormatSchema });

/**
 * Lists the choices in `--help` without commander's `.choices()`, which would also reject a value
 * before `withInput` sees it; the schema is the one place the value is checked.
 */
export function logFormatOption(defaultFormat: LogFormat): Option {
  const option = new Option(
    '--log-format <format>',
    'pretty for a terminal, json for CI and files',
  ).default(defaultFormat);
  option.argChoices = [...logFormatSchema.options];
  return option;
}
