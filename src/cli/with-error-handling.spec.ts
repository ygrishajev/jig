import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { ConfigInvalid } from '../domain/errors.js';
import { type FailureOutput, withErrorHandling } from './with-error-handling.js';

describe('withErrorHandling', () => {
  it('prints the error and sets a failing exit code instead of rejecting', async () => {
    const failure = new ConfigInvalid({ message: faker.lorem.sentence() });
    const { handle, output } = setup({
      command: async () => {
        throw failure;
      },
    });

    await expect(handle()).resolves.toBeUndefined();
    expect(output).toEqual({ printed: [failure.message], exitCode: 1 });
  });

  it('prints a thrown value that is not an Error as it is', async () => {
    const thrown = faker.lorem.sentence();
    const { handle, output } = setup({
      command: async () => {
        throw thrown;
      },
    });

    await handle();

    expect(output).toEqual({ printed: [thrown], exitCode: 1 });
  });

  it('passes the arguments through and leaves the exit code alone on success', async () => {
    const received: unknown[] = [];
    const argument = faker.lorem.word();
    const { handle, output } = setup({
      command: async (...args) => {
        received.push(...args);
      },
    });

    await handle(argument);

    expect(received).toEqual([argument]);
    expect(output).toEqual({ printed: [], exitCode: undefined });
  });

  function setup(input: { command: (...args: unknown[]) => Promise<void> }) {
    const output: { printed: string[]; exitCode?: number } = {
      printed: [],
      exitCode: undefined,
    };
    const failureOutput: FailureOutput = {
      printError: (message) => output.printed.push(message),
      setExitCode: (code) => (output.exitCode = code),
    };
    const handle = withErrorHandling(input.command, failureOutput);
    return { handle, output };
  }
});
