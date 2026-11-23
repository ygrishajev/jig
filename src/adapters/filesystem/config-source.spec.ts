import { faker } from '@faker-js/faker';
import { panic, type Result } from 'better-result';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { ConfigNotJson, ConfigUnreadable, ConfigUnwritable } from '../../config/config-source.js';
import { ConfigInvalid } from '../../config/errors.js';
import { loadConfig, stepsWithoutAgent } from '../../config/load-config.js';
import { updateConfig } from '../../config/update-config.js';
import { configDestination, configFileSource } from './config-source.js';

describe('config file source', () => {
  describe('configDestination', () => {
    it("resolves the repository's own settings file", () => {
      const repoRoot = faker.system.directoryPath();

      const destination = configDestination(repoRoot);

      expect(destination).toEqual({
        path: path.join(repoRoot, 'jig.config.json'),
        name: 'jig.config.json',
        custom: false,
      });
    });

    it('resolves a custom destination against the repository root, under the name it was given', () => {
      const repoRoot = faker.system.directoryPath();
      const customPath = path.join(faker.word.noun(), `${faker.word.noun()}.json`);

      const destination = configDestination(repoRoot, customPath);

      expect(destination).toEqual({
        path: path.join(repoRoot, customPath),
        name: customPath,
        custom: true,
      });
    });
  });

  describe('read', () => {
    it('finds the JSON written at the destination', async () => {
      const json = { [faker.word.noun()]: faker.lorem.word() };
      const { source } = await setup({ contents: JSON.stringify(json) });

      expect(unwrap(source.read())).toEqual({ kind: 'present', json });
    });

    it('reports nothing at the destination as absent, with why it was not found', async () => {
      const { source, destination } = await setup({});

      expect(unwrap(source.read())).toEqual({
        kind: 'absent',
        detail: `ENOENT: no such file or directory, open '${destination.path}'`,
      });
    });

    it('reports a link to nothing as absent', async () => {
      const { source, destination } = await setup({});
      await symlink(path.join(await tempDirectory(), faker.string.uuid()), destination.path);

      expect(unwrap(source.read()).kind).toBe('absent');
    });

    it('reports something it cannot read where it is, with why', async () => {
      const { source, destination } = await setup({});
      await mkdir(destination.path);

      const result = source.read();

      expect(result.isErr() && result.error).toBeInstanceOf(ConfigUnreadable);
      expect(result.isErr() && result.error).toMatchObject({
        location: destination.path,
        detail: 'EISDIR: illegal operation on a directory, read',
      });
    });

    it('reports contents that are not JSON', async () => {
      const { source } = await setup({ contents: `{"${faker.word.noun()}":` });

      const result = source.read();

      expect(result.isErr() && result.error).toBeInstanceOf(ConfigNotJson);
    });
  });

  describe('write', () => {
    it('creates the file, indented by two spaces and ending in a newline', async () => {
      const settings = { setupCommand: faker.word.verb(), verifyCommand: faker.word.verb() };
      const { source, contents } = await setup({});

      unwrap(await source.write(settings));

      expect(await contents()).toBe(`${JSON.stringify(settings, null, 2)}\n`);
    });

    it('replaces everything the file held', async () => {
      const settings = { [faker.word.noun()]: faker.lorem.word() };
      const { source, contents } = await setup({
        contents: JSON.stringify({ [`${faker.word.noun()}Old`]: faker.lorem.word() }),
      });

      unwrap(await source.write(settings));

      expect(JSON.parse(await contents())).toEqual(settings);
    });

    it('reports a destination it cannot write where it is', async () => {
      const { source, destination } = await setup({
        customPath: path.join(faker.word.noun(), `${faker.word.noun()}.json`),
      });

      const result = await source.write({ setupCommand: faker.word.verb() });

      expect(result.isErr() && result.error).toBeInstanceOf(ConfigUnwritable);
      expect(result.isErr() && result.error.location).toBe(destination.path);
    });
  });

  describe('with config policy', () => {
    it("loads every default and no agent when the repository's own file is absent", async () => {
      const { source } = await setup({});

      const config = unwrap(loadConfig(source));

      expect(config).toMatchObject({ mergeMode: 'manual', designGate: 'auto' });
      expect(stepsWithoutAgent(config)).toEqual([
        'planner',
        'implementer',
        'reviewer',
        'describer',
      ]);
    });

    it('loads a custom file instead of the repository one', async () => {
      const { source, repoRoot } = await setup({
        customPath: `${faker.word.noun()}.json`,
        contents: JSON.stringify({ mergeMode: 'auto' }),
      });
      await writeFile(
        path.join(repoRoot, 'jig.config.json'),
        JSON.stringify({ mergeMode: 'manual' }),
      );

      expect(unwrap(loadConfig(source)).mergeMode).toBe('auto');
    });

    it('refuses an absent custom file, naming it and why', async () => {
      const { source, destination } = await setup({ customPath: `${faker.word.noun()}.json` });

      expectExactly(
        loadConfig(source),
        `Cannot read ${destination.name}: ENOENT: no such file or directory, open '${destination.path}'`,
      );
    });

    it('refuses a file it cannot read, naming it and why', async () => {
      const { source, destination } = await setup({});
      await mkdir(destination.path);

      expectExactly(
        loadConfig(source),
        `Cannot read ${destination.name}: EISDIR: illegal operation on a directory, read`,
      );
    });

    it('refuses a file that is not JSON, naming it', async () => {
      const { source, destination } = await setup({ contents: '{"mergeMode":' });

      expectStartsWith(loadConfig(source), `${destination.name} is not valid JSON: `);
    });

    it('refuses a key the schema does not know, naming the file and the key', async () => {
      const key = `${faker.word.noun()}Setting`;
      const { source, destination } = await setup({
        contents: JSON.stringify({ [key]: faker.lorem.word() }),
      });

      const message = failureMessage(loadConfig(source));

      expect(message.startsWith(`${destination.name} is not valid — `)).toBe(true);
      expect(message).toContain(key);
    });

    it('updates a file, keeping every key it was not given, known or not', async () => {
      const kept = {
        verifyCommand: `npm run ${faker.word.verb()}`,
        [faker.word.noun()]: faker.lorem.word(),
      };
      const setupCommand = `npm ${faker.word.verb()}`;
      const { source, contents } = await setup({ contents: JSON.stringify(kept) });

      unwrap(await updateConfig(source, { setupCommand }));

      expect(JSON.parse(await contents())).toEqual({ ...kept, setupCommand });
    });

    it('creates an absent custom file on update', async () => {
      const values = { setupCommand: faker.word.verb() };
      const { source, contents } = await setup({ customPath: `${faker.word.noun()}.json` });

      unwrap(await updateConfig(source, values));

      expect(JSON.parse(await contents())).toEqual(values);
    });

    it('round trips provider selections without serializing inferred models', async () => {
      const steps = {
        planner: { provider: 'claude' },
        implementer: { provider: 'codex', model: faker.word.noun() },
        reviewer: { provider: 'opencode', model: `openrouter/${faker.word.noun()}` },
      };
      const { source, contents } = await setup({
        customPath: `${faker.word.noun()}.json`,
        contents: '{}',
      });

      unwrap(await updateConfig(source, steps));

      expect(JSON.parse(await contents())).toEqual(steps);
      expect(unwrap(loadConfig(source))).toMatchObject(steps);
      expect(unwrap(loadConfig(source)).planner?.model).toBeUndefined();
    });

    it.each([
      ['a list', '[]'],
      ['not JSON', faker.lorem.word()],
    ])('refuses to update a file that is %s and leaves it as it was', async (_case, written) => {
      const { source, destination, contents } = await setup({ contents: written });

      expectExactly(
        await updateConfig(source, { setupCommand: faker.word.verb() }),
        `${destination.name} must hold a JSON object to add settings to.`,
      );
      expect(await contents()).toBe(written);
    });

    it('reports a file it cannot update by where it is', async () => {
      const { source, destination } = await setup({
        customPath: path.join(faker.word.noun(), `${faker.word.noun()}.json`),
      });

      expectStartsWith(
        await updateConfig(source, { setupCommand: faker.word.verb() }),
        `Cannot read or write ${destination.path}: ENOENT: no such file or directory`,
      );
    });
  });

  function failureMessage(result: Result<unknown, ConfigInvalid>): string {
    if (result.isOk()) panic('Expected the config to be refused');
    expect(result.error).toBeInstanceOf(ConfigInvalid);
    return result.error.message;
  }

  function expectExactly(result: Result<unknown, ConfigInvalid>, message: string): void {
    expect(failureMessage(result)).toBe(message);
  }

  function expectStartsWith(result: Result<unknown, ConfigInvalid>, prefix: string): void {
    expect(failureMessage(result).startsWith(prefix)).toBe(true);
  }

  async function setup(input: { customPath?: string; contents?: string }) {
    const repoRoot = await tempDirectory('jig-config-source-');
    const destination = configDestination(repoRoot, input.customPath);
    if (input.contents !== undefined) await writeFile(destination.path, input.contents);
    const contents = () => readFile(destination.path, 'utf-8');
    return { repoRoot, destination, source: configFileSource(destination), contents };
  }
});
