import { faker } from '@faker-js/faker';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { fakeStandardInput } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { messageOf } from '../adapters/exception-details.js';
import type { StandardInput } from '../adapters/terminal/standard-input.js';
import { RunRequestInvalid } from '../app/run-request-invalid.js';
import { readRequest } from './read-request.js';

describe('readRequest', () => {
  it('returns the text of a request file, resolved against the working directory', async () => {
    const { cwd, name, text, read } = await setup({ fileText: sentence() });

    const result = await read({ file: name });

    expect(result.unwrap()).toEqual({ text, file: name });
    expect(cwd).not.toBe(process.cwd());
  });

  it('returns the text piped to standard input, with no file', async () => {
    const text = sentence();
    const { read } = await setup({ standardInput: fakeStandardInput({ text }) });

    const result = await read({ stdin: true });

    expect(result.unwrap()).toEqual({ text });
  });

  it('refuses a terminal without reading from it', async () => {
    const standardInput = fakeStandardInput({ isTerminal: true });
    const { read } = await setup({ standardInput });

    const result = await read({ stdin: true });

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
    expect(standardInput.readAll).not.toHaveBeenCalled();
  });

  it.each(['', ' \n\t\n'])('refuses empty piped text %j', async (text) => {
    const { read } = await setup({ standardInput: fakeStandardInput({ text }) });

    const result = await read({ stdin: true });

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
  });

  it.each(['', ' \n\t\n'])('refuses a request file with empty text %j', async (fileText) => {
    const { name, read } = await setup({ fileText });

    const result = await read({ file: name });

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
  });

  it('refuses a request file that cannot be read', async () => {
    const { read } = await setup({});

    const result = await read({ file: `${faker.string.uuid()}.md` });

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
  });

  it('refuses standard input that fails to read', async () => {
    const message = faker.lorem.sentence();
    const standardInput: StandardInput = {
      isTerminal: false,
      readAll: () => Promise.reject(new Error(message)),
    };
    const { read } = await setup({ standardInput });

    const result = await read({ stdin: true });

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
    expect(result.isErr() && result.error.message).toContain(message);
  });

  function sentence() {
    return `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`;
  }

  async function setup(input: { fileText?: string; standardInput?: StandardInput }) {
    const cwd = await tempDirectory('jig-request-');
    const name = `${faker.string.uuid()}.md`;
    const text = input.fileText ?? '';
    if (input.fileText !== undefined) await writeFile(path.join(cwd, name), text);
    const standardInput = input.standardInput ?? fakeStandardInput();
    return {
      cwd,
      name,
      text,
      read: (source: Parameters<typeof readRequest>[0]) =>
        readRequest(source, { cwd, standardInput, messageOf }),
    };
  }
});
