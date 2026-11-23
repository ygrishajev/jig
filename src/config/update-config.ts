import { Result } from 'better-result';
import { z } from 'zod';

import { type ConfigSource, ConfigUnreadable } from './config-source.js';
import { ConfigInvalid } from './errors.js';

/**
 * Sets the given keys over every other key as the operator wrote it. Absent settings are created;
 * settings that are not a JSON object are left for the operator to fix.
 */
export function updateConfig(
  source: ConfigSource,
  values: Record<string, unknown>,
): Promise<Result<void, ConfigInvalid>> {
  return Result.gen(async function* () {
    const current = yield* currentSettings(source);
    const written = await source.write({ ...current, ...values });
    return written.mapError(
      ({ location, detail }) => new ConfigInvalid({ message: cannotReadOrWrite(location, detail) }),
    );
  });
}

function currentSettings(source: ConfigSource): Result<Record<string, unknown>, ConfigInvalid> {
  const read = source.read();
  if (read.isErr()) {
    return Result.err(
      read.error instanceof ConfigUnreadable
        ? new ConfigInvalid({ message: cannotReadOrWrite(read.error.location, read.error.detail) })
        : notAnObject(source),
    );
  }
  if (read.value.kind === 'absent') return Result.ok({});
  const parsed = settingsObjectSchema.safeParse(read.value.json);
  return parsed.success ? Result.ok(parsed.data) : Result.err(notAnObject(source));
}

function cannotReadOrWrite(location: string, detail: string): string {
  return `Cannot read or write ${location}: ${detail}`;
}

function notAnObject(source: ConfigSource): ConfigInvalid {
  return new ConfigInvalid({
    message: `${source.name} must hold a JSON object to add settings to.`,
  });
}

/** Permissive, so an update keeps keys this version of jig does not know. */
const settingsObjectSchema = z.record(z.unknown());
