import type { AwilixContainer } from 'awilix';
import type { Result } from 'better-result';
import type { z } from 'zod';

import type { AppCradle } from '../app/container.js';
import type { JigError } from '../domain/errors.js';
import { type AppOptions, type Invocation, withApp } from './with-app.js';
import { type FailureOutput, withErrorHandling } from './with-error-handling.js';
import { withInput } from './with-input.js';

/** What a command reads from and reports to; a spec passes its own, the CLI leaves both to the process. */
export interface CommandIo {
  invocation?: Invocation;
  failureOutput?: FailureOutput;
}

/** Every app command parses, opens the app and reports a failure in this one order, so none can skip a step. */
export function appAction<Schema extends z.ZodType<AppOptions, z.ZodTypeDef, unknown>>(
  schema: Schema,
  run: (
    input: z.output<Schema>,
    app: AwilixContainer<AppCradle>,
  ) => Promise<Result<void, JigError>>,
  { invocation, failureOutput }: CommandIo = {},
): (...actionArguments: unknown[]) => Promise<void> {
  return withErrorHandling(
    withInput(schema, (input) => withApp(input, (app) => run(input, app), invocation)),
    failureOutput,
  );
}
