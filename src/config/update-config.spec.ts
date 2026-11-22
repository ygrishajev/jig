import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { unwrap } from '../../tests/support/unwrap.js';
import { ConfigInvalid } from '../domain/errors.js';
import { configFileFor } from './load-config.js';
import { configWithSettings } from './update-config.js';

describe('configWithSettings', () => {
  it('sets the given keys over the current ones and keeps every other key as it was', () => {
    const kept = { [faker.word.noun()]: faker.lorem.word() };
    const replaced = faker.word.verb();
    const setupCommand = `npm ${faker.word.verb()}`;
    const { file } = setup({});

    const updated = configWithSettings(file, { ...kept, setupCommand: replaced }, { setupCommand });

    expect(unwrap(updated)).toEqual({ ...kept, setupCommand });
  });

  it.each([
    ['a list', [faker.word.noun()]],
    ['no JSON at all', undefined],
    ['a string', faker.lorem.word()],
  ])('refuses current contents that are %s, naming the file', (_case, current) => {
    const { file } = setup({ preset: `${faker.word.noun()}.json` });

    const result = configWithSettings(file, current, { setupCommand: faker.word.verb() });

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(result.isErr() && result.error.message).toContain(file.name);
  });

  function setup(input: { preset?: string }) {
    return { file: configFileFor(faker.system.directoryPath(), input.preset) };
  }
});
