import { faker } from '@faker-js/faker';
import { Panic, Result } from 'better-result';
import { describe, expect, it, vi } from 'vitest';

import { exceptionDetails } from '../adapters/exception-details.js';
import { ConfigInvalid } from '../domain/errors.js';
import type { ExceptionDetails } from '../ports/exception-details.js';
import { type FailureOutput, withErrorHandling } from './with-error-handling.js';

describe('withErrorHandling', () => {
  it('prints an expected failure as its message alone', async () => {
    const failure = new ConfigInvalid({ message: faker.lorem.sentence() });
    const { handle, output } = setup({ command: async () => Result.err(failure) });

    await expect(handle()).resolves.toBeUndefined();

    expect(output).toEqual({ printed: [failure.message], exitCode: 1 });
  });

  it('prints an integration failure without requiring a core error class', async () => {
    const failure = { message: faker.lorem.sentence() };
    const { handle, output } = setup({ command: async () => Result.err(failure) });
    await handle();
    expect(output).toEqual({ printed: [failure.message], exitCode: 1 });
  });

  it('prints a thrown error unedited, as its own stack', async () => {
    const thrown = new Error(faker.lorem.sentence());
    const { handle, output } = setup({
      command: async () => {
        throw thrown;
      },
    });

    await handle();

    expect(output).toEqual({ printed: [thrown.stack], exitCode: 1 });
  });

  it('prints what was first thrown, not the panics wrapped around it', async () => {
    const thrown = new Error(faker.lorem.sentence());
    const { handle, output } = setup({
      command: async () => {
        const inner = new Panic({ message: faker.lorem.sentence(), cause: thrown });
        throw new Panic({ message: faker.lorem.sentence(), cause: inner });
      },
    });

    await handle();

    expect(output.printed).toEqual([thrown.stack]);
  });

  it('reports a thrown value that is not an Error by its text', async () => {
    const thrown = faker.lorem.sentence();
    const { handle, output } = setup({
      command: async () => {
        throw thrown;
      },
    });

    await handle();

    expect(output).toEqual({ printed: [thrown], exitCode: 1 });
  });

  it('prints the stack of the root cause the supplied exception details find', async () => {
    const thrown = new Error(faker.lorem.sentence());
    const found = new Error(faker.lorem.sentence());
    const rootCause = vi.fn((_error: unknown) => found);
    const { handle, output } = setup({
      command: async () => {
        throw thrown;
      },
      exceptionDetails: { ...exceptionDetails, rootCause },
    });

    await handle();

    expect(rootCause).toHaveBeenCalledWith(thrown);
    expect(output.printed).toEqual([found.stack]);
  });

  it('describes a non-Error root cause with the supplied message reader', async () => {
    const description = faker.lorem.sentence();
    const { handle, output } = setup({
      command: async () => {
        throw faker.number.int();
      },
      exceptionDetails: { ...exceptionDetails, messageOf: () => description },
    });

    await handle();

    expect(output.printed).toEqual([description]);
  });

  it('passes the arguments through and leaves the exit code alone on success', async () => {
    const received: unknown[] = [];
    const argument = faker.lorem.word();
    const { handle, output } = setup({
      command: async (...args) => {
        received.push(...args);
        return Result.ok();
      },
    });

    await handle(argument);

    expect(received).toEqual([argument]);
    expect(output).toEqual({ printed: [], exitCode: undefined });
  });

  function setup(input: {
    command: (...args: unknown[]) => Promise<Result<void, { message: string }>>;
    exceptionDetails?: ExceptionDetails;
  }) {
    const output: { printed: string[]; exitCode?: number } = {
      printed: [],
      exitCode: undefined,
    };
    const failureOutput: FailureOutput = {
      printError: (message) => output.printed.push(message),
      setExitCode: (code) => (output.exitCode = code),
    };
    const handle = withErrorHandling(
      input.command,
      input.exceptionDetails ?? exceptionDetails,
      failureOutput,
    );
    return { handle, output };
  }
});
