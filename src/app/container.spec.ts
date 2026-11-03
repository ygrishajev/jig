import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { describe, expect, it, onTestFinished } from 'vitest';

import { runId } from '../../tests/support/builders.js';
import { FakeAgentSession, InMemoryRunStore } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { parseEnvironment } from '../config/environment.js';
import { createAppContainer, withRunScope } from './container.js';

describe('withRunScope', () => {
  it("hands the work the run's sandbox and closes it once the work is done", async () => {
    const { app, session, run } = await setup();

    const used = await withRunScope(
      app,
      run,
      new InMemoryRunStore(),
      {},
      async (dependencies) => dependencies.ports.agent,
    );

    expect(used).toBe(session);
    expect(session.closed).toBe(true);
  });

  it('closes the sandbox when the work inside it fails', async () => {
    const { app, session, run } = await setup();
    const failure = new Error(faker.lorem.sentence());

    await expect(
      withRunScope(app, run, new InMemoryRunStore(), {}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(session.closed).toBe(true);
  });

  async function setup() {
    const repoRoot = await tempDirectory('jig-run-scope-');
    const session = new FakeAgentSession(repoRoot);
    const app = createAppContainer({
      repoRoot,
      logFormat: 'json',
      logLevel: 'silent',
      environment: parseEnvironment({}),
    });
    app.register({ openSession: asValue(async () => session) });
    onTestFinished(() => app.dispose());
    return { app, session, run: { runId: runId(), baseBranch: faker.git.branch() } };
  }
});
