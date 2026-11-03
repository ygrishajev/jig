import { z } from 'zod';

/**
 * A run id becomes a `.jig/<runId>` directory, a `jig/run/<runId>` branch and a
 * `refs/jig/<runId>` ref, so only lowercase letters, digits and hyphens get through.
 */
export const runIdSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'a run id is lowercase letters, digits and hyphens')
  .brand<'RunId'>();

export type RunId = z.infer<typeof runIdSchema>;
