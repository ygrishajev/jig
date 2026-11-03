import { Command } from 'commander';
import type { z } from 'zod';

/**
 * A commander action that receives the command's arguments and options as one object, parsed
 * by `schema`: named arguments by their declared names, options by their camel-cased ones.
 */
export function withInput<Schema extends z.ZodTypeAny>(
  schema: Schema,
  run: (input: z.output<Schema>) => Promise<void>,
) {
  return async (...actionArguments: unknown[]) => {
    const command = actionArguments.at(-1);
    if (!(command instanceof Command)) throw new Error('withInput must wrap a commander action');
    const parsed = schema.safeParse(inputOf(command));
    if (!parsed.success) throw new CommandInputInvalid(describeIssues(parsed.error));
    await run(parsed.data);
  };
}

function inputOf(command: Command) {
  const named = command.registeredArguments.map((argument, index) => [
    argument.name(),
    command.processedArgs[index],
  ]);
  return { ...Object.fromEntries(named), ...command.opts() };
}

/** What the operator typed does not fit the command; reported like any other failed command. */
export class CommandInputInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandInputInvalid';
  }
}

function describeIssues(error: z.ZodError) {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('\n');
}
