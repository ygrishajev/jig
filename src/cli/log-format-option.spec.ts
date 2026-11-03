import { faker } from '@faker-js/faker';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import type { LogFormat } from '../adapters/logging/create-logger.js';
import { logFormatInputSchema, logFormatOption } from './log-format-option.js';
import { CommandInputInvalid, withInput } from './with-input.js';

describe('logFormatOption', () => {
  it('hands the action the chosen format', async () => {
    const format = faker.helpers.arrayElement<LogFormat>(['pretty', 'json']);
    const { run, received } = setup();

    await run(['--log-format', format]);

    expect(received()).toBe(format);
  });

  it('leaves an unknown format to the input schema to refuse', async () => {
    const { run, received } = setup();

    await expect(run(['--log-format', faker.lorem.word()])).rejects.toBeInstanceOf(
      CommandInputInvalid,
    );
    expect(received()).toBeUndefined();
  });

  function setup() {
    let received: LogFormat | undefined;
    const command = new Command()
      .exitOverride()
      .addOption(logFormatOption())
      .action(
        withInput(logFormatInputSchema, async ({ logFormat }) => {
          received = logFormat;
        }),
      );
    return {
      run: (args: string[]) => command.parseAsync(args, { from: 'user' }),
      received: () => received,
    };
  }
});
