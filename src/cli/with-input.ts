import { panic, Result, TaggedError } from 'better-result';
import { Command } from 'commander';
import type { z } from 'zod';

import { describeIssue } from '../domain/validation-issue.js';

/**
 * A commander action that receives the command's arguments and options as one object, parsed
 * by `schema`: named arguments by their declared names, options by their camel-cased ones.
 */
export function withInput<Schema extends z.ZodTypeAny, E extends { message: string }>(
  schema: Schema,
  run: (input: z.output<Schema>) => Promise<Result<void, E>>,
) {
  return async (...actionArguments: unknown[]): Promise<Result<void, E | CommandInputInvalid>> => {
    const command = actionArguments.at(-1);
    if (!(command instanceof Command)) panic('withInput must wrap a commander action');
    const parsed = schema.safeParse(inputOf(command));
    if (!parsed.success) {
      return Result.err(new CommandInputInvalid({ message: describeInputIssues(parsed.error) }));
    }
    return run(parsed.data);
  };
}

function inputOf(command: Command): Record<string, unknown> {
  const named = command.registeredArguments.map((argument, index) => [
    argument.name(),
    command.processedArgs[index],
  ]);
  return { ...Object.fromEntries(named), ...command.opts() };
}

/** What the operator typed does not fit the command. */
export class CommandInputInvalid extends TaggedError('CommandInputInvalid')<{ message: string }> {}

/** One line per issue, so a terminal shows each on its own. */
function describeInputIssues(error: z.ZodError): string {
  return error.issues.map(describeIssue).join('\n');
}
