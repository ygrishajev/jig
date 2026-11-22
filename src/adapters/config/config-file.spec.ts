import { faker } from '@faker-js/faker';
import type { Result } from 'better-result';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { CONFIG_FILE, configFileFor, stepsWithoutAgent } from '../../config/load-config.js';
import { ConfigInvalid } from '../../domain/errors.js';
import { readConfigFile, updateConfigFile } from './config-file.js';

describe('config file', () => {
  describe('readConfigFile', () => {
    it('gives every default and no agent when the repository has no config', async () => {
      const { file } = await setup({});

      const config = unwrap(readConfigFile(file));

      expect(config).toMatchObject({ mergeMode: 'manual', designGate: 'auto' });
      expect(stepsWithoutAgent(config)).toEqual([
        'planner',
        'implementer',
        'reviewer',
        'describer',
      ]);
    });

    it("reads the repository's own config", async () => {
      const verifyCommand = `npm run ${faker.word.verb()}`;
      const { file } = await setup({ contents: JSON.stringify({ verifyCommand }) });

      expect(unwrap(readConfigFile(file)).verifyCommand).toBe(verifyCommand);
    });

    it('reads a preset named by the operator instead of the repository config', async () => {
      const { file, repoRoot } = await setup({
        preset: `${faker.word.noun()}.json`,
        contents: JSON.stringify({ mergeMode: 'auto' }),
      });
      await writeFile(path.join(repoRoot, CONFIG_FILE), JSON.stringify({ mergeMode: 'manual' }));

      expect(unwrap(readConfigFile(file)).mergeMode).toBe('auto');
    });

    it('refuses a named preset that does not exist instead of falling back to defaults', async () => {
      const { file } = await setup({ preset: `${faker.word.noun()}.json` });

      expectInvalid(readConfigFile(file), file.name);
    });

    it('refuses a config it cannot read', async () => {
      const { file } = await setup({});
      await mkdir(file.path);

      expectInvalid(readConfigFile(file), file.name);
    });

    it('reports a config file that is not JSON as invalid config', async () => {
      const { file } = await setup({ contents: '{"mergeMode":' });

      expectInvalid(readConfigFile(file), file.name);
    });

    it('applies the config schema to what the file holds', async () => {
      const key = `${faker.word.noun()}Setting`;
      const { file } = await setup({ contents: JSON.stringify({ [key]: faker.lorem.word() }) });

      expectInvalid(readConfigFile(file), key);
    });
  });

  describe('updateConfigFile', () => {
    it('sets the given keys and keeps every other key as it was', async () => {
      const kept = { verifyCommand: `npm run ${faker.word.verb()}` };
      const setupCommand = `npm ${faker.word.verb()}`;
      const { file, read } = await setup({ contents: JSON.stringify(kept) });

      unwrap(await updateConfigFile(file, { setupCommand }));

      expect(JSON.parse(await read())).toEqual({ ...kept, setupCommand });
    });

    it('keeps keys it does not know', async () => {
      const unknown = { [faker.word.noun()]: faker.lorem.word() };
      const { file, read } = await setup({ contents: JSON.stringify(unknown) });

      unwrap(await updateConfigFile(file, { setupCommand: faker.word.verb() }));

      expect(JSON.parse(await read())).toMatchObject(unknown);
    });

    it('writes the config indented by two spaces and ending in a newline', async () => {
      const values = { setupCommand: faker.word.verb(), verifyCommand: faker.word.verb() };
      const { file, read } = await setup({});

      unwrap(await updateConfigFile(file, values));

      expect(await read()).toBe(`${JSON.stringify(values, null, 2)}\n`);
    });

    it('round trips provider selections without serializing inferred models', async () => {
      const steps = {
        planner: { provider: 'claude' },
        implementer: { provider: 'codex', model: faker.word.noun() },
        reviewer: { provider: 'opencode', model: `openrouter/${faker.word.noun()}` },
      };
      const { file, read } = await setup({ preset: `${faker.word.noun()}.json`, contents: '{}' });

      unwrap(await updateConfigFile(file, steps));

      expect(JSON.parse(await read())).toEqual(steps);
      expect(unwrap(readConfigFile(file))).toMatchObject(steps);
      expect(unwrap(readConfigFile(file)).planner?.model).toBeUndefined();
    });

    it.each([
      ['a list', '[]'],
      ['not JSON', faker.lorem.word()],
    ])('refuses a config file that is %s and leaves it as it was', async (_case, contents) => {
      const { file, read } = await setup({ contents });

      expectInvalid(await updateConfigFile(file, { setupCommand: faker.word.verb() }), file.name);
      expect(await read()).toBe(contents);
    });

    it('reports a config it cannot write', async () => {
      const { repoRoot } = await setup({});
      const file = configFileFor(
        repoRoot,
        path.join(faker.word.noun(), `${faker.word.noun()}.json`),
      );

      expectInvalid(await updateConfigFile(file, { setupCommand: faker.word.verb() }), file.path);
    });
  });

  function expectInvalid(result: Result<unknown, ConfigInvalid>, mention: string): void {
    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(result.isErr() && result.error.message).toContain(mention);
  }

  async function setup(input: { preset?: string; contents?: string }) {
    const repoRoot = await tempDirectory('jig-config-file-');
    const file = configFileFor(repoRoot, input.preset);
    if (input.contents !== undefined) await writeFile(file.path, input.contents);
    const read = () => readFile(file.path, 'utf-8');
    return { repoRoot, file, read };
  }
});
