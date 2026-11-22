import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { Result } from 'better-result';
import { describe, expect, it, onTestFinished } from 'vitest';

import { aJigConfig, runId } from '../../tests/support/builders.js';
import { FakeAgentSession, InMemoryRunStore } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { configDestination } from '../adapters/filesystem/config-source.js';
import { parseEnvironment } from '../config/environment.js';
import { MergeFailed, SandboxUnavailable } from '../domain/errors.js';
import { createAppContainer, withRunScope } from './container.js';

describe('withRunScope', () => {
  it("hands the work the run's sandbox and closes it once the work is done", async () => {
    const { app, session, run } = await setup();

    const used = await withRunScope(app, run, new InMemoryRunStore(), {}, async (dependencies) =>
      Result.ok(dependencies.ports.agent),
    );

    expect(unwrap(used)).toBe(session);
    expect(session.closed).toBe(true);
  });

  it('gives up opening the sandbox after the bounded retries with the last failure', async () => {
    const { app, run, openAttempts } = await setup({ failWith: sandboxUnavailable() });
    const store = new InMemoryRunStore();

    const result = await withRunScope(app, run, store, {}, async () =>
      Result.ok(faker.lorem.word()),
    );

    expect(result.isErr() && result.error).toBeInstanceOf(SandboxUnavailable);
    expect(openAttempts()).toBe(3);
  });

  it("passes on the work's own failure and closes the sandbox", async () => {
    const { app, session, run } = await setup();
    const failure = new MergeFailed({ message: faker.lorem.sentence() });

    const result = await withRunScope(app, run, new InMemoryRunStore(), {}, async () =>
      Result.err(failure),
    );

    expect(result.isErr() && result.error).toBe(failure);
    expect(session.closed).toBe(true);
  });

  it('closes the sandbox when the work inside it throws', async () => {
    const { app, session, run } = await setup();
    const failure = new Error(faker.lorem.sentence());

    await expect(
      withRunScope(app, run, new InMemoryRunStore(), {}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(session.closed).toBe(true);
  });

  async function setup(input: { failWith?: SandboxUnavailable } = {}) {
    const repoRoot = await tempDirectory('jig-run-scope-');
    const session = new FakeAgentSession(repoRoot);
    const config = aJigConfig();
    const app = createAppContainer({
      repoRoot,
      configDestination: configDestination(repoRoot),
      logFormat: 'json',
      logLevel: 'silent',
      environment: unwrap(parseEnvironment({}, faker.system.directoryPath())),
      config,
    });
    let attempts = 0;
    app.register({
      settings: asValue({ ...app.cradle.settings, maxStepRetries: 2, retryDelayMs: 0 }),
      openSession: asValue(async () => {
        attempts++;
        return input.failWith ? Result.err(input.failWith) : Result.ok(session);
      }),
    });
    onTestFinished(() => app.dispose());
    return {
      app,
      session,
      run: { runId: runId(), baseBranch: faker.git.branch() },
      openAttempts: () => attempts,
    };
  }
});

function sandboxUnavailable() {
  return new SandboxUnavailable({ message: faker.lorem.sentence() });
}
