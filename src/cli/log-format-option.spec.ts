import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import type { LogFormat } from '../ports/observability.js';
import { logFormatInputSchema, logFormatOption } from './log-format-option.js';
import { CommandInputInvalid, withInput } from './with-input.js';

describe('logFormatOption', () => {
  it('hands the action the chosen format', async () => {
    const format = faker.helpers.arrayElement<LogFormat>(['pretty', 'json']);
    const { run, received } = setup();

    await run(['--log-format', format]);

    expect(received()).toBe(format);
  });

  it('hands the action the default it was given when no format is chosen', async () => {
    const defaultFormat = faker.helpers.arrayElement<LogFormat>(['pretty', 'json']);
    const { run, received } = setup({ defaultFormat });

    await run([]);

    expect(received()).toBe(defaultFormat);
  });

  it('leaves an unknown format to the input schema to refuse', async () => {
    const { run, received } = setup();

    const result = await run(['--log-format', faker.lorem.word()]);

    expect(result.isErr() && result.error).toBeInstanceOf(CommandInputInvalid);
    expect(received()).toBeUndefined();
  });

  function setup({ defaultFormat = 'json' }: { defaultFormat?: LogFormat } = {}) {
    let received: LogFormat | undefined;
    let outcome: Result<void, CommandInputInvalid> = Result.ok();
    const action = withInput(logFormatInputSchema, async ({ logFormat }) => {
      received = logFormat;
      return Result.ok();
    });
    const command = new Command()
      .exitOverride()
      .addOption(logFormatOption(defaultFormat))
      .action(async (...actionArguments: unknown[]) => {
        outcome = await action(...actionArguments);
      });
    return {
      run: async (args: string[]) => {
        await command.parseAsync(args, { from: 'user' });
        return outcome;
      },
      received: () => received,
    };
  }
});
