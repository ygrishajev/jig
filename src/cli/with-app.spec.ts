import { faker } from '@faker-js/faker';
import { asFunction } from 'awilix';
import { describe, expect, it, vi } from 'vitest';
import { withApp } from './with-app.js';

describe('withApp', () => {
  it("returns what the command produced and disposes the app's resources", async () => {
    const { run, disposed } = setup();
    const produced = faker.lorem.word();

    await expect(run(async () => produced)).resolves.toBe(produced);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("disposes the app's resources when the command fails", async () => {
    const { run, disposed } = setup();
    const failure = new Error(faker.lorem.sentence());

    await expect(
      run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(disposed).toHaveBeenCalledOnce();
  });

  function setup() {
    const disposed = vi.fn();
    const run = <T>(command: () => Promise<T>) =>
      withApp('json', async (app) => {
        app.register({
          clock: asFunction(() => ({ now: Date.now }))
            .singleton()
            .disposer(disposed),
        });
        app.resolve('clock');
        return command();
      });
    return { run, disposed };
  }
});
