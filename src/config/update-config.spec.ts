import { faker } from '@faker-js/faker';
import type { Result } from 'better-result';
import { describe, expect, it } from 'vitest';

import { InMemoryConfigSource } from '../../tests/support/fakes.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { ConfigInvalid } from '../domain/errors.js';
import { updateConfig } from './update-config.js';

describe('updateConfig', () => {
  it('sets the given keys over the current ones and keeps every other key as it was', async () => {
    const kept = { [faker.word.noun()]: faker.lorem.word() };
    const setupCommand = `npm ${faker.word.verb()}`;
    const { source } = setup({ json: { ...kept, setupCommand: faker.word.verb() } });

    unwrap(await updateConfig(source, { setupCommand }));

    expect(source.stored).toEqual({ kind: 'present', json: { ...kept, setupCommand } });
  });

  it.each([true, false])(
    'creates absent settings with just the given keys when custom is %s',
    async (custom) => {
      const values = { setupCommand: faker.word.verb(), verifyCommand: faker.word.verb() };
      const { source } = setup({ custom });

      unwrap(await updateConfig(source, values));

      expect(source.stored).toEqual({ kind: 'present', json: values });
    },
  );

  it.each([
    ['a list', [faker.word.noun()]],
    ['a string', faker.lorem.word()],
    ['null', null],
  ])('refuses settings that are %s and leaves them as they were', async (_case, json) => {
    const { source } = setup({ json });

    const result = await updateConfig(source, { setupCommand: faker.word.verb() });

    expectExactly(result, `${source.name} must hold a JSON object to add settings to.`);
    expect(source.stored).toEqual({ kind: 'present', json });
  });

  it('refuses settings that are not JSON as no object to add to', async () => {
    const { source } = setup({ failure: 'not-json' });

    const result = await updateConfig(source, { setupCommand: faker.word.verb() });

    expectExactly(result, `${source.name} must hold a JSON object to add settings to.`);
  });

  it.each(['unreadable', 'unwritable'] as const)(
    'reports settings that are %s where they are, with why',
    async (failure) => {
      const { source } = setup({ json: {}, failure });

      const result = await updateConfig(source, { setupCommand: faker.word.verb() });

      expectExactly(result, `Cannot read or write ${source.location}: ${source.detail}`);
    },
  );

  function expectExactly(result: Result<void, ConfigInvalid>, message: string): void {
    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(result.isErr() && result.error.message).toBe(message);
  }

  function setup(input: {
    json?: unknown;
    custom?: boolean;
    failure?: 'unreadable' | 'not-json' | 'unwritable';
  }) {
    return { source: new InMemoryConfigSource(input) };
  }
});
