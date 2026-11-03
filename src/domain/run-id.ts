import { z } from 'zod';

import { RunRequestInvalid } from './errors.js';

/**
 * A run id becomes a `.jig/<runId>` directory, a `jig/run/<runId>` branch and a
 * `refs/jig/<runId>` ref, so only lowercase letters, digits and hyphens get through.
 */
export const runIdSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'a run id is lowercase letters, digits and hyphens')
  .brand<'RunId'>();

export type RunId = z.infer<typeof runIdSchema>;

/** Turns an id typed by a person into a `RunId`, refusing one that is unsafe as a path or ref. */
export function parseRunId(raw: string): RunId {
  const parsed = runIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RunRequestInvalid(
      `Invalid run id "${raw}" — use lowercase letters, digits and hyphens (it becomes a directory and a branch name).`,
    );
  }
  return parsed.data;
}
