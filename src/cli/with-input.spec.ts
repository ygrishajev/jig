import { faker } from '@faker-js/faker';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CommandInputInvalid, withInput } from './with-input.js';

describe('withInput', () => {
  it('hands the action its named arguments and options as one parsed object', async () => {
    const name = faker.word.noun();
    const count = faker.number.int({ min: 1, max: 100 });
    const { run, received } = setup(
      z.object({ name: z.string(), count: z.coerce.number(), dryRun: z.boolean() }),
    );

    await run([name, '--count', String(count), '--dry-run']);

    expect(received()).toEqual({ name, count, dryRun: true });
  });

  it('leaves out an optional argument that was not given', async () => {
    const { run, received } = setup(z.object({ name: z.string().optional() }));

    await run([]);

    expect(received()).toEqual({});
  });

  it('refuses input the schema rejects, naming the field and keeping the schema message', async () => {
    const message = faker.lorem.sentence();
    const { run, received } = setup(z.object({ name: z.string().regex(/^\d+$/, message) }));

    const failure = run([faker.lorem.word()]);

    await expect(failure).rejects.toThrow(new CommandInputInvalid(`name: ${message}`));
    expect(received()).toBeUndefined();
  });

  function setup<Schema extends z.ZodTypeAny>(schema: Schema) {
    let received: z.output<Schema> | undefined;
    const command = new Command()
      .exitOverride()
      .argument('[name]')
      .option('--count <count>')
      .option('--dry-run')
      .action(
        withInput(schema, async (input) => {
          received = input;
        }),
      );
    return {
      run: (args: string[]) => command.parseAsync(args, { from: 'user' }),
      received: () => received,
    };
  }
});
