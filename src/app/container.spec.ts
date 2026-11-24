import { faker } from '@faker-js/faker';
import { asFunction, asValue } from 'awilix';
import { Result } from 'better-result';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { aJigConfig, runId } from '../../tests/support/builders.js';
import { FakeAgentSession, InMemoryRunStore } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { configDestination } from '../adapters/filesystem/config-source.js';
import { parseEnvironment } from '../config/environment.js';
import type { JigConfig } from '../config/load-config.js';
import { SandboxUnavailable } from '../ports/agent-session.js';
import { createAppContainer, runCapabilitiesOf } from './container.js';

describe('runCapabilitiesOf', () => {
  it("opens a scope whose engine works in the run's sandbox, and closes that sandbox when asked", async () => {
    const { openScope, session, run } = await setup();
    const store = new InMemoryRunStore();

    const scope = unwrap(await openScope(run, store, undefined));

    expect(scope.engineDependencies.ports.agent).toBe(session);
    expect(scope.engineDependencies.store).toBe(store);
    expect(session.closed).toBe(false);
    unwrap(await scope.closeSession());
    expect(session.closed).toBe(true);
    await scope.dispose();
  });

  it('gives up opening the sandbox after the bounded retries with the last failure', async () => {
    const { openScope, run, openAttempts } = await setup({ failWith: sandboxUnavailable() });

    const result = await openScope(run, new InMemoryRunStore(), undefined);

    expect(result.isErr() && result.error).toBeInstanceOf(SandboxUnavailable);
    expect(openAttempts()).toBe(3);
  });

  it("lets the run's telemetry hear the run's events", async () => {
    const { openScope, run } = await setup();
    const heard = vi.fn();
    const telemetry = { observer: { handle: heard }, shutdown: async () => {} };

    const scope = unwrap(await openScope(run, new InMemoryRunStore(), telemetry));
    scope.engineDependencies.events.publish({
      type: 'runResumed',
      runId: run.runId,
      phase: 'context',
    });

    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }));
    await scope.dispose();
  });

  it('disposes the scope and passes the panic on when opening the sandbox panics', async () => {
    const bug = new Error(faker.lorem.sentence());
    const { openScope, run, scopeDisposals } = await setup({ openPanic: bug });

    const thrown = await openScope(run, new InMemoryRunStore(), undefined).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBe(bug);
    expect(scopeDisposals()).toHaveLength(1);
  });

  it('closes the opened sandbox before disposing the scope when building the scope panics', async () => {
    const bug = new Error(faker.lorem.sentence());
    const { openScope, run, scopeDisposals } = await setup({ workspacePanic: bug });

    const thrown = await openScope(run, new InMemoryRunStore(), undefined).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBe(bug);
    expect(scopeDisposals()).toEqual([{ sessionClosed: true }]);
  });

  async function setup(
    input: { failWith?: SandboxUnavailable; openPanic?: Error; workspacePanic?: Error } = {},
  ) {
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
    const disposals: { sessionClosed: boolean }[] = [];
    const { workspacePanic } = input;
    app.register({
      settings: asValue({ ...app.cradle.settings, maxStepRetries: 2, retryDelayMs: 0 }),
      openSession: asFunction(() => async () => {
        attempts++;
        if (input.openPanic) throw input.openPanic;
        return input.failWith ? Result.err(input.failWith) : Result.ok(session);
      })
        .scoped()
        .disposer(() => {
          disposals.push({ sessionClosed: session.closed });
        }),
      ...(workspacePanic && {
        config: asValue({
          ...config,
          get commitSigning(): JigConfig['commitSigning'] {
            throw workspacePanic;
          },
        }),
      }),
    });
    onTestFinished(() => app.dispose());
    return {
      openScope: runCapabilitiesOf(app).sandbox.openScope,
      session,
      run: { runId: runId(), baseBranch: faker.git.branch() },
      openAttempts: () => attempts,
      scopeDisposals: () => disposals,
    };
  }
});

function sandboxUnavailable() {
  return new SandboxUnavailable({ message: faker.lorem.sentence() });
}
