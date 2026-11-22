import { Result } from 'better-result';
import { z } from 'zod';

import { ConfigInvalid } from '../domain/errors.js';
import type { ConfigFile } from './load-config.js';

/**
 * The config with the given keys set over every other key as the operator wrote it. Only an object
 * can take more keys; anything else, unparsable JSON included, is left for the operator to fix.
 */
export function configWithSettings(
  file: ConfigFile,
  current: unknown,
  values: Record<string, unknown>,
): Result<Record<string, unknown>, ConfigInvalid> {
  const parsed = configObjectSchema.safeParse(current);
  return parsed.success
    ? Result.ok({ ...parsed.data, ...values })
    : Result.err(
        new ConfigInvalid({
          message: `${file.name} must hold a JSON object to add settings to.`,
        }),
      );
}

/** Permissive, so an update keeps keys this version of jig does not know. */
const configObjectSchema = z.record(z.unknown());
