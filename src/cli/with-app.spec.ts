import { faker } from '@faker-js/faker';
import { asFunction, type AwilixContainer } from 'awilix';
import { Result } from 'better-result';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createTempRepo } from '../../tests/support/temp-repo.js';
import type { AppCradle } from '../app/container.js';
import { ConfigInvalid, type JigError } from '../domain/errors.js';
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

  it('opens the app on the config preset it was given', async () => {
    const preset = `${faker.word.noun()}.json`;
    const { run, cwd } = await setup({ config: preset });
    await writeFile(path.join(cwd, preset), JSON.stringify({ mergeMode: 'auto' }));

    const opened = (
      await run(async (app) =>
        Result.ok({ file: app.cradle.configFile.path, mergeMode: app.cradle.config.mergeMode }),
      )
    ).unwrap();

    expect(opened).toEqual({ file: path.join(cwd, preset), mergeMode: 'auto' });
  });

  it('refuses to start below the repository root, before the command runs', async () => {
    const { run } = await setup({ belowRoot: true });
    const command = vi.fn();

    const result = await run(command);

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(command).not.toHaveBeenCalled();
  });

  async function setup(
    input: { belowRoot?: boolean; environment?: NodeJS.ProcessEnv; config?: string } = {},
  ) {
    const repo = await createTempRepo();
    const cwd = input.belowRoot ? path.join(repo.dir, faker.word.noun()) : repo.dir;
    await mkdir(cwd, { recursive: true });
    const disposed = vi.fn();
    const run = <T>(command: (app: AwilixContainer<AppCradle>) => Promise<Result<T, JigError>>) =>
      withApp(
        { logFormat: 'json', config: input.config },
        async (app) => {
          app.register({
            clock: asFunction(() => ({ now: Date.now }))
              .singleton()
              .disposer(disposed),
          });
          app.resolve('clock');
          return command(app);
        },
        { cwd, environment: input.environment ?? {} },
      );
    return { run, disposed, cwd };
  }
});
