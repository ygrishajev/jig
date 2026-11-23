import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { Result } from 'better-result';
import { describe, expect, it, onTestFinished } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { runId } from '../../tests/support/builders.js';
import { FakeAgentSession, InMemoryRunStore } from '../../tests/support/fakes.js';
import { repositoryConfig } from '../../tests/support/repository-config.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { exceptionDetails } from '../adapters/exception-details.js';
import { configDestination } from '../adapters/filesystem/config-source.js';
import { retryResult } from '../adapters/retry.js';
import { parseEnvironment } from '../config/environment.js';
import type { ExceptionDetails } from '../ports/exception-details.js';
import type { RetryPolicy, RetryResult } from '../ports/retry.js';
import { SandboxUnavailable } from '../ports/sandbox.js';
import { MergeFailed } from '../ports/workspace.js';
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

  it('hands the engine and its steps the retry and exception capabilities the app holds', async () => {
    const suppliedRetry: RetryResult = (operation, policy) => retryResult(operation, policy);
    const suppliedDetails = mock<ExceptionDetails>();
    const { app, run } = await setup({
      retryResult: suppliedRetry,
      exceptionDetails: suppliedDetails,
    });

    const used = await withRunScope(app, run, new InMemoryRunStore(), {}, async (dependencies) =>
      Result.ok(dependencies),
    );

    expect(unwrap(used).ports.retryResult).toBe(suppliedRetry);
    expect(unwrap(used).exceptionDetails).toBe(suppliedDetails);
  });

  it("opens the sandbox through the app's retry capability under the run's settings", async () => {
    const policies: RetryPolicy<unknown>[] = [];
    const recordingRetry: RetryResult = (operation, policy) => {
      policies.push(policy);
      return retryResult(operation, policy);
    };
    const { app, run } = await setup({ retryResult: recordingRetry });

    await withRunScope(app, run, new InMemoryRunStore(), {}, async () => Result.ok());

    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      retries: app.cradle.settings.maxStepRetries,
      delayMs: app.cradle.settings.retryDelayMs,
    });
  });

  async function setup(
    input: {
      failWith?: SandboxUnavailable;
      retryResult?: RetryResult;
      exceptionDetails?: ExceptionDetails;
    } = {},
  ) {
    const repoRoot = await tempDirectory('jig-run-scope-');
    const session = new FakeAgentSession(repoRoot);
    const config = repositoryConfig(repoRoot);
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
    if (input.retryResult) app.register({ retryResult: asValue(input.retryResult) });
    if (input.exceptionDetails) {
      app.register({ exceptionDetails: asValue(input.exceptionDetails) });
    }
    onTestFinished(() => app.dispose());
    return {
      app,
      session,
      run: { runId: runId(), baseBranch: faker.git.branch() },
      openAttempts: () => attempts,
    };
  }
});

describe('createAppContainer', () => {
  it('holds the adapter retry and exception implementations', async () => {
    const { app } = await setup();

    expect(app.cradle.retryResult).toBe(retryResult);
    expect(app.cradle.exceptionDetails).toBe(exceptionDetails);
  });

  async function setup() {
    const repoRoot = await tempDirectory('jig-app-');
    const app = createAppContainer({
      repoRoot,
      configDestination: configDestination(repoRoot),
      logFormat: 'json',
      logLevel: 'silent',
      environment: unwrap(parseEnvironment({}, faker.system.directoryPath())),
      config: repositoryConfig(repoRoot),
    });
    onTestFinished(() => app.dispose());
    return { app };
  }
});

function sandboxUnavailable() {
  return new SandboxUnavailable({ message: faker.lorem.sentence() });
}
