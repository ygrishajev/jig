import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { Result } from 'better-result';
import { simpleGit } from 'simple-git';
import { describe, expect, it, onTestFinished } from 'vitest';

import { runId } from '../../tests/support/builders.js';
import { FakeAgentSession, InMemoryRunStore } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import type { OpenSessionInput } from '../adapters/sandcastle/open-session.js';
import { parseEnvironment } from '../config/environment.js';
import { configFileFor, loadConfig } from '../config/load-config.js';
import { MergeFailed, SandboxUnavailable, SetupCommandFailed } from '../domain/errors.js';
import { runBranchFor } from '../domain/run-state.js';
import { createAppContainer, withRunScope, withThrowawaySandbox } from './container.js';

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
    const config = unwrap(loadConfig(configFileFor(repoRoot)));
    const app = createAppContainer({
      repoRoot,
      configFile: configFileFor(repoRoot),
      logFormat: 'json',
      logLevel: 'silent',
      environment: unwrap(parseEnvironment({})),
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

describe('withThrowawaySandbox', () => {
  it('closes the sandbox and removes its branch when the work inside it fails', async () => {
    const { app, session, branches, repoRoot } = await setup();
    const failure = new Error(faker.lorem.sentence());

    await expect(
      withThrowawaySandbox(app, null, async (): Promise<Result<void, never>> => {
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

    const result = await withThrowawaySandbox(app, `npm ${faker.word.verb()}`, async () =>
      Result.ok(),
    );

    expect(result.isErr() && result.error).toBe(failure);
    expect(opened()).toBe(1);
  });

  it("keeps the work's own failure when the sandbox does not close either", async () => {
    const { app, session } = await setup();
    session.failCloseWith = sandboxUnavailable();
    const failure = new MergeFailed({ message: faker.lorem.sentence() });

    const result = await withThrowawaySandbox(app, null, async () => Result.err(failure));

    expect(result.isErr() && result.error).toBe(failure);
  });

  it('reports a sandbox that does not close after the work succeeded', async () => {
    const { app, session } = await setup();
    const closeFailure = sandboxUnavailable();
    session.failCloseWith = closeFailure;

    const result = await withThrowawaySandbox(app, null, async () => Result.ok());

    expect(result.isErr() && result.error).toBe(closeFailure);
  });

  async function setup(input: { failWith?: SetupCommandFailed } = {}) {
    const { dir: repoRoot } = await createTempRepo();
    const session = new FakeAgentSession(repoRoot);
    const branches: string[] = [];
    let opened = 0;
    const app = createAppContainer({
      repoRoot,
      configFile: configFileFor(repoRoot),
      logFormat: 'json',
      logLevel: 'silent',
      environment: unwrap(parseEnvironment({})),
      config: unwrap(loadConfig(configFileFor(repoRoot))),
    });
    app.register({
      openSession: asValue(async ({ run }: OpenSessionInput) => {
        opened++;
        if (input.failWith) return Result.err(input.failWith);
        const branch = runBranchFor(run.runId);
        await simpleGit({ baseDir: repoRoot }).branch([branch]);
        branches.push(branch);
        return Result.ok(session);
      }),
    });
    onTestFinished(() => app.dispose());
    return { app, session, branches, repoRoot, opened: () => opened };
  }
});

function sandboxUnavailable() {
  return new SandboxUnavailable({ message: faker.lorem.sentence() });
}
