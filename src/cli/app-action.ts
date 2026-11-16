import type { AwilixContainer } from 'awilix';
import { Result } from 'better-result';
import type { z } from 'zod';

import type { AppCradle } from '../app/container.js';
import type { JigError } from '../domain/errors.js';
import { type AppOptions, type Invocation, processInvocation, withApp } from './with-app.js';
import { type FailureOutput, withErrorHandling } from './with-error-handling.js';
import { withInput } from './with-input.js';

/** What a command reads from and reports to; a spec passes its own, the CLI leaves both to the process. */
export interface CommandIo {
  invocation?: Invocation;
  failureOutput?: FailureOutput;
}

/**
 * Every app command parses, prepares, opens the app and reports a failure in this one order, so
 * none can skip a step. `prepare` reads what the command needs from outside the app, such as
 * piped text, so a refusal comes before the app opens.
 */
export function appAction<
  Schema extends z.ZodType<AppOptions, z.ZodTypeDef, unknown>,
  Prepared = undefined,
>(
  schema: Schema,
  run: (
    input: z.output<Schema>,
    app: AwilixContainer<AppCradle>,
    prepared: Prepared,
  ) => Promise<Result<void, JigError>>,
  { invocation, failureOutput }: CommandIo = {},
  prepare?: (
    input: z.output<Schema>,
    invocation: Invocation,
  ) => Promise<Result<Prepared, JigError>>,
): (...actionArguments: unknown[]) => Promise<void> {
  const commandInvocation = invocation ?? processInvocation();
  return withErrorHandling(
    withInput(schema, async (input) => {
      const prepared = prepare ? await prepare(input, commandInvocation) : Result.ok(undefined);
      if (prepared.isErr()) return Result.err(prepared.error);
      return withApp(
        input,
        (app) => run(input, app, prepared.value as Prepared),
        commandInvocation,
      );
    }),
    failureOutput,
  );
}
