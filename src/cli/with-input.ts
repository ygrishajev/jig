import { panic, Result } from 'better-result';
import { Command } from 'commander';
import type { z } from 'zod';

import { describeIssues } from '../config/describe-issues.js';
import { CommandInputInvalid } from './command-input-invalid.js';

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
      return Result.err(new CommandInputInvalid({ message: describeIssues(parsed.error, '\n') }));
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
