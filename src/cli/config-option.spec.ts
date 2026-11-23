import { Result } from 'better-result';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { presetName } from '../../tests/support/builders.js';
import { presetInputSchema, presetOption, type PresetSelection } from './config-option.js';
import { CommandInputInvalid, withInput } from './with-input.js';

describe('presetOption', () => {
  it('hands the action the preset it names', async () => {
    const name = presetName();
    const { run, received } = setup();

    await run(['--preset', name]);

    expect(received()).toEqual({ kind: 'named', name });
  });

  it('hands the action a request to ask when no name follows it', async () => {
    const { run, received } = setup();

    await run(['--preset']);

    expect(received()).toEqual({ kind: 'ask' });
  });

  it('hands the action no preset when it is left out', async () => {
    const { run, received } = setup();

    await run([]);

    expect(received()).toBeUndefined();
  });

  it('leaves a name that could leave the presets directory to the input schema to refuse', async () => {
    const { run, received } = setup();

    const result = await run(['--preset', '../x']);

    expect(result.isErr() && result.error).toBeInstanceOf(CommandInputInvalid);
    expect(received()).toBeUndefined();
  });

  function setup() {
    let received: PresetSelection | undefined;
    let outcome: Result<void, CommandInputInvalid> = Result.ok();
    const action = withInput(presetInputSchema, async ({ preset }) => {
      received = preset;
      return Result.ok();
    });
    const command = new Command()
      .exitOverride()
      .addOption(presetOption())
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
