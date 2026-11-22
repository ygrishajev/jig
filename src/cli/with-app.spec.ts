import { faker } from '@faker-js/faker';
import { asFunction, asValue, type AwilixContainer } from 'awilix';
import { Result } from 'better-result';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { presetName } from '../../tests/support/builders.js';
import { fakeStandardInput, InMemoryConfigSource } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { configFileSource } from '../adapters/filesystem/config-source.js';
import { presetDirectoriesSource } from '../adapters/filesystem/preset-source.js';
import type { PresetPick } from '../adapters/terminal/ask-for-preset.js';
import { type AppCradle, createAppContainer } from '../app/container.js';
import type { ConfigSource } from '../config/config-source.js';
import type { Preset, PresetName } from '../config/presets.js';
import { ConfigInvalid, type JigError } from '../domain/errors.js';
import type { PresetSelection } from './config-option.js';
import { withApp } from './with-app.js';

describe('withApp', () => {
  it("returns what the command produced and disposes the app's resources", async () => {
    const { run, disposed } = await setup();
    const produced = faker.lorem.word();

    const result = await run(async () => Result.ok(produced));

    expect(result.unwrap()).toBe(produced);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("disposes the app's resources when the command fails", async () => {
    const { run, disposed } = await setup();
    const failure = new ConfigInvalid({ message: faker.lorem.sentence() });

    const result = await run(async () => Result.err(failure));

    expect(result.isErr() && result.error).toBe(failure);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("disposes the app's resources when the command throws", async () => {
    const { run, disposed } = await setup();
    const failure = new Error(faker.lorem.sentence());

    await expect(
      run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('opens the app on the directory and the environment it was started with, parsed', async () => {
    const directory = faker.system.directoryPath();
    const { run, cwd } = await setup({ environment: { JIG_CODEX_AUTH_DIR: directory } });

    const opened = (
      await run(async (app) =>
        Result.ok({
          repoRoot: app.cradle.repoRoot,
          codexAuthDirectory: app.cradle.environment.codexAuthDirectory,
        }),
      )
    ).unwrap();

    expect(opened).toEqual({ repoRoot: cwd, codexAuthDirectory: directory });
  });

  it('refuses an environment it cannot parse, before the command runs', async () => {
    const { run } = await setup({ environment: { JIG_IMAGE_CACHE: faker.word.noun() } });
    const command = vi.fn();

    const result = await run(command);

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(command).not.toHaveBeenCalled();
  });

  it('refuses a config it cannot parse, before the command runs', async () => {
    const { run, cwd } = await setup();
    await writeFile(path.join(cwd, 'jig.config.json'), '{"mergeMode":');
    const command = vi.fn();

    const result = await run(command);

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(command).not.toHaveBeenCalled();
  });

  it('refuses a config it cannot read, before the command runs', async () => {
    const source = new InMemoryConfigSource({ failure: 'unreadable' });
    const { run, createApp } = await setup({ configSource: source });
    const command = vi.fn();

    const result = await run(command);

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(result.isErr() && result.error.message).toBe(
      `Cannot read ${source.name}: ${source.detail}`,
    );
    expect(command).not.toHaveBeenCalled();
    expect(createApp).not.toHaveBeenCalled();
  });

  it('opens the app on the config preset it was given', async () => {
    const preset = `${faker.word.noun()}.json`;
    const { run, cwd } = await setup({ config: preset });
    await writeFile(path.join(cwd, preset), JSON.stringify({ mergeMode: 'auto' }));

    const opened = (
      await run(async (app) =>
        Result.ok({
          file: app.cradle.configDestination.path,
          name: app.cradle.configSource.name,
          mergeMode: app.cradle.config.mergeMode,
        }),
      )
    ).unwrap();

    expect(opened).toEqual({ file: path.join(cwd, preset), name: preset, mergeMode: 'auto' });
  });

  it("swaps in the agents of the preset it was given from the operator's home directory", async () => {
    const home = await tempDirectory('jig-with-app-home-');
    const model = faker.word.noun();
    const preset = presetName();
    await writePreset(home, preset, { reviewer: { provider: 'claude', model } });
    const { run, logger } = await setup({
      preset: { kind: 'named', name: preset },
      environment: { HOME: home },
    });

    const reviewer = unwrap(await run(async (app) => Result.ok(app.cradle.config.reviewer)));

    expect(reviewer).toEqual({ provider: 'claude', model });
    expect(logger.info).toHaveBeenCalledWith({ preset }, expect.any(String));
  });

  it.each([{}, { HOME: '' }])(
    'looks for presets in the home directory it was given when HOME is unset in %j',
    async (environment) => {
      const fallbackHomeDirectory = await tempDirectory('jig-with-app-fallback-home-');
      const model = faker.word.noun();
      const preset = presetName();
      await writePreset(fallbackHomeDirectory, preset, { reviewer: { provider: 'claude', model } });
      const { run } = await setup({
        preset: { kind: 'named', name: preset },
        environment,
        fallbackHomeDirectory,
      });

      const reviewer = unwrap(await run(async (app) => Result.ok(app.cradle.config.reviewer)));

      expect(reviewer).toEqual({ provider: 'claude', model });
    },
  );

  it('refuses a preset it cannot find, before the command runs', async () => {
    const home = await tempDirectory('jig-with-app-home-');
    const { run, askForPreset, createApp } = await setup({
      preset: { kind: 'named', name: presetName() },
      environment: { HOME: home },
    });

    const result = await run(vi.fn());

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(createApp).not.toHaveBeenCalled();
    expect(askForPreset).not.toHaveBeenCalled();
  });

  it('opens the project config untouched when no preset is asked for', async () => {
    const model = faker.word.noun();
    const { run, cwd, askForPreset, logger } = await setup();
    await writeProjectReviewer(cwd, model);

    const reviewer = unwrap(await run(async (app) => Result.ok(app.cradle.config.reviewer)));

    expect(reviewer).toEqual({ provider: 'claude', model });
    expect(askForPreset).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('asks which of the presets found to use and swaps in the agents of the one picked', async () => {
    const home = await tempDirectory('jig-with-app-home-');
    const model = faker.word.noun();
    const preset = presetName();
    await writePreset(home, preset, { reviewer: { provider: 'claude', model } });
    const { run, askForPreset, logger } = await setup({
      preset: { kind: 'ask' },
      environment: { HOME: home },
      pick: { kind: 'preset', name: preset },
    });

    const reviewer = unwrap(await run(async (app) => Result.ok(app.cradle.config.reviewer)));

    expect(reviewer).toEqual({ provider: 'claude', model });
    expect(askForPreset.mock.calls[0]?.[0].map(({ name }: Preset) => name)).toEqual([preset]);
    expect(logger.info).toHaveBeenCalledWith({ preset }, expect.any(String));
  });

  it('opens the project config untouched when the operator picks no preset', async () => {
    const home = await tempDirectory('jig-with-app-home-');
    const model = faker.word.noun();
    await writePreset(home, presetName(), {
      reviewer: { provider: 'codex', model: faker.word.noun() },
    });
    const { run, cwd, logger } = await setup({
      preset: { kind: 'ask' },
      environment: { HOME: home },
      pick: { kind: 'none' },
    });
    await writeProjectReviewer(cwd, model);

    const reviewer = unwrap(await run(async (app) => Result.ok(app.cradle.config.reviewer)));

    expect(reviewer).toEqual({ provider: 'claude', model });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('applies the picked preset over the config file it was given', async () => {
    const home = await tempDirectory('jig-with-app-home-');
    const model = faker.word.noun();
    const preset = presetName();
    const configFile = `${faker.word.noun()}.json`;
    await writePreset(home, preset, { reviewer: { provider: 'claude', model } });
    const { run, cwd } = await setup({
      config: configFile,
      preset: { kind: 'ask' },
      environment: { HOME: home },
      pick: { kind: 'preset', name: preset },
    });
    await writeFile(path.join(cwd, configFile), JSON.stringify({ mergeMode: 'auto' }));

    const opened = unwrap(
      await run(async (app) =>
        Result.ok({ mergeMode: app.cradle.config.mergeMode, reviewer: app.cradle.config.reviewer }),
      ),
    );

    expect(opened).toEqual({ mergeMode: 'auto', reviewer: { provider: 'claude', model } });
  });

  it('refuses a preset nobody picked, before the command runs', async () => {
    const home = await tempDirectory('jig-with-app-home-');
    await writePreset(home, presetName(), {});
    const { run, askForPreset, createApp } = await setup({
      preset: { kind: 'ask' },
      environment: { HOME: home },
      pick: undefined,
    });

    const result = await run(vi.fn());

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(askForPreset).toHaveBeenCalledOnce();
    expect(createApp).not.toHaveBeenCalled();
  });

  it('refuses to ask when there are no presets to pick from, before the command runs', async () => {
    const home = await tempDirectory('jig-with-app-home-');
    const { run, askForPreset, createApp } = await setup({
      preset: { kind: 'ask' },
      environment: { HOME: home },
      pick: { kind: 'none' },
    });

    const result = await run(vi.fn());

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(askForPreset).not.toHaveBeenCalled();
    expect(createApp).not.toHaveBeenCalled();
  });

  it('refuses to start below the repository root, before the command runs', async () => {
    const { run } = await setup({ belowRoot: true });
    const command = vi.fn();

    const result = await run(command);

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(command).not.toHaveBeenCalled();
  });

  async function setup(
    input: {
      belowRoot?: boolean;
      environment?: NodeJS.ProcessEnv;
      fallbackHomeDirectory?: string;
      config?: string;
      preset?: PresetSelection;
      pick?: PresetPick;
      configSource?: ConfigSource;
    } = {},
  ) {
    const repo = await createTempRepo();
    const askForPreset = vi.fn(async (_presets: Preset[]) => input.pick);
    const builtinPresetsDirectory = await tempDirectory('jig-with-app-builtin-');
    const fallbackHomeDirectory =
      input.fallbackHomeDirectory ?? (await tempDirectory('jig-with-app-fallback-home-'));
    const cwd = input.belowRoot ? path.join(repo.dir, faker.word.noun()) : repo.dir;
    await mkdir(cwd, { recursive: true });
    const disposed = vi.fn();
    const logger = mock<Logger>();
    const createApp = vi.fn((options: Parameters<typeof createAppContainer>[0]) =>
      createAppContainer(options).register({ logger: asValue(logger) }),
    );
    const run = <T>(command: (app: AwilixContainer<AppCradle>) => Promise<Result<T, JigError>>) =>
      withApp(
        { logFormat: 'json', config: input.config, preset: input.preset },
        async (app) => {
          app.register({
            clock: asFunction(() => ({ now: Date.now }))
              .singleton()
              .disposer(disposed),
          });
          app.resolve('clock');
          return command(app);
        },
        {
          cwd,
          environment: input.environment ?? {},
          fallbackHomeDirectory,
          askForPreset,
          createAppContainer: createApp,
          configSourceAt: (destination) => input.configSource ?? configFileSource(destination),
          standardInput: fakeStandardInput(),
          presetSourceAt: (locations) =>
            presetDirectoriesSource(locations, builtinPresetsDirectory),
        },
      );
    return { run, disposed, cwd, askForPreset, createApp, logger };
  }
});

async function writePreset(home: string, name: PresetName, contents: object) {
  await mkdir(path.join(home, '.jig', 'presets'), { recursive: true });
  await writeFile(path.join(home, '.jig', 'presets', `${name}.json`), JSON.stringify(contents));
}

async function writeProjectReviewer(cwd: string, model: string) {
  await writeFile(
    path.join(cwd, 'jig.config.json'),
    JSON.stringify({ reviewer: { provider: 'claude', model } }),
  );
}
