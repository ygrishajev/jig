import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { simpleGit } from 'simple-git';
import { describe, expect, it, onTestFinished } from 'vitest';

import { runId } from '../../tests/support/builders.js';
import { FakeAgentSession, InMemoryRunStore } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import type { OpenSessionInput } from '../adapters/sandcastle/open-session.js';
import { parseEnvironment } from '../config/environment.js';
import { SetupCommandFailed } from '../domain/errors.js';
import { runBranchFor } from '../domain/run-state.js';
import { createAppContainer, withRunScope, withThrowawaySandbox } from './container.js';

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

describe('withThrowawaySandbox', () => {
  it('closes the sandbox and removes its branch when the work inside it fails', async () => {
    const { app, session, branches, repoRoot } = await setup();
    const failure = new Error(faker.lorem.sentence());

    await expect(
      withThrowawaySandbox(app, null, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(session.closed).toBe(true);
    expect(branches.length).toBe(1);
    expect((await simpleGit({ baseDir: repoRoot }).branchLocal()).all).not.toContain(branches[0]);
  });

  it('gives up at once when the setup command fails, so the caller gets the failure', async () => {
    const failure = new SetupCommandFailed({
      message: faker.lorem.sentence(),
      output: faker.lorem.paragraph(),
    });
    const { app, opened } = await setup({ failWith: failure });

    await expect(
      withThrowawaySandbox(app, `npm ${faker.word.verb()}`, async () => {}),
    ).rejects.toBe(failure);
    expect(opened()).toBe(1);
  });

  async function setup(input: { failWith?: Error } = {}) {
    const { dir: repoRoot } = await createTempRepo();
    const session = new FakeAgentSession(repoRoot);
    const branches: string[] = [];
    let opened = 0;
    const app = createAppContainer({
      repoRoot,
      logFormat: 'json',
      logLevel: 'silent',
      environment: parseEnvironment({}),
    });
    app.register({
      openSession: asValue(async ({ run }: OpenSessionInput) => {
        opened++;
        if (input.failWith) throw input.failWith;
        const branch = runBranchFor(run.runId);
        await simpleGit({ baseDir: repoRoot }).branch([branch]);
        branches.push(branch);
        return session;
      }),
    });
    onTestFinished(() => app.dispose());
    return { app, session, branches, repoRoot, opened: () => opened };
  }
});
