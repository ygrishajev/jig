import { faker } from '@faker-js/faker';
import { asFunction, type AwilixContainer } from 'awilix';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createTempRepo } from '../../tests/support/temp-repo.js';
import type { AppCradle } from '../app/container.js';
import { ConfigInvalid } from '../domain/errors.js';
import { withApp } from './with-app.js';

describe('withApp', () => {
  it("returns what the command produced and disposes the app's resources", async () => {
    const { run, disposed } = await setup();
    const produced = faker.lorem.word();

    await expect(run(async () => produced)).resolves.toBe(produced);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("disposes the app's resources when the command fails", async () => {
    const { run, disposed } = await setup();
    const failure = new Error(faker.lorem.sentence());

    await expect(
      run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('opens the app on the directory and environment it was started with', async () => {
    const environment = { [faker.word.noun().toUpperCase()]: faker.lorem.word() };
    const { run, cwd } = await setup({ environment });

    const opened = await run(async (app) => ({
      repoRoot: app.cradle.repoRoot,
      environment: app.cradle.environment,
    }));

    expect(opened).toEqual({ repoRoot: cwd, environment });
  });

  it('refuses to start below the repository root, before the command runs', async () => {
    const { run } = await setup({ belowRoot: true });
    const command = vi.fn();

    await expect(run(command)).rejects.toBeInstanceOf(ConfigInvalid);
    expect(command).not.toHaveBeenCalled();
  });

  async function setup(input: { belowRoot?: boolean; environment?: NodeJS.ProcessEnv } = {}) {
    const repo = await createTempRepo();
    const cwd = input.belowRoot ? path.join(repo.dir, faker.word.noun()) : repo.dir;
    await mkdir(cwd, { recursive: true });
    const disposed = vi.fn();
    const run = <T>(command: (app: AwilixContainer<AppCradle>) => Promise<T>) =>
      withApp(
        'json',
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
