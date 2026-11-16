import { faker } from '@faker-js/faker';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../tests/support/temp-directory.js';
import { RunRequestInvalid } from '../domain/errors.js';
import { readRequest } from './read-request.js';

describe('readRequest', () => {
  it('returns the text of the request file', async () => {
    const { file, text } = await setup({ exists: true });

    const result = await readRequest(file);

    expect(result.unwrap()).toBe(text);
  });

  it('refuses a request file that cannot be read', async () => {
    const { file } = await setup({ exists: false });

    const result = await readRequest(file);

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
  });

  async function setup(input: { exists: boolean }) {
    const directory = await tempDirectory('jig-request-');
    const file = path.join(directory, `${faker.string.uuid()}.md`);
    const text = `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`;
    if (input.exists) await writeFile(file, text);
    return { file, text };
  }
});
