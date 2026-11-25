import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { runId, runSettings } from '../../tests/support/builders.js';
import { FakeWorkspace } from '../../tests/support/fake-workspace.js';
import {
  FakeAgentSession,
  InMemoryRunStore,
  RecordingEventSink,
  SteppingClock,
} from '../../tests/support/fakes.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { ConfigInvalid } from '../config/errors.js';
import type { RunIdentity } from '../domain/run-state.js';
import {
  SandboxCredentialsInvalid,
  SandboxPreparationInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
} from '../ports/agent-session.js';
import { LocalPreparationFailed } from '../ports/local-state.js';
import type { RunTelemetry, WarningLog } from '../ports/observability.js';
import { acquireRunScope, type SandboxStartLog } from './run-scope.js';
import type { SandboxOpenFailure } from './sandbox-runtime.js';

describe('acquireRunScope', () => {
  it("hands the engine the run's sandbox, workspace, store and events, and closes the sandbox when asked", async () => {
    const { open, session, workspace, events } = setup({});
    const store = new InMemoryRunStore();

    const scope = unwrap(await open(store));

    expect(scope.engineDependencies.ports).toEqual({ agent: session, workspace });
    expect(scope.engineDependencies.store).toBe(store);
    expect(scope.engineDependencies.events).toBe(events);
    expect(session.closed).toBe(false);
    unwrap(await scope.closeSession());
    expect(session.closed).toBe(true);
  });

  it("builds the run's reporting for its own run, with the telemetry it is given", async () => {
    const { open, reportedFor, run } = setup({});
    const telemetry = mock<RunTelemetry>();

    await open(new InMemoryRunStore(), telemetry);

    expect(reportedFor).toEqual([{ run: run(), telemetry }]);
  });

  it('opens the sandbox once a start that may pass succeeds', async () => {
    const { open, openAttempts, startLog } = setup({ failWith: [sandboxUnavailable()] });

    const result = await open(new InMemoryRunStore());

    expect(result.isOk()).toBe(true);
    expect(openAttempts()).toBe(2);
    expect(startLog.warn).toHaveBeenCalledTimes(1);
  });

  it('gives up opening the sandbox after the bounded retries with the last failure', async () => {
    const last = sandboxUnavailable();
    const { open, openAttempts } = setup({
      failWith: [sandboxUnavailable(), sandboxUnavailable(), last],
    });

    const result = await open(new InMemoryRunStore());

    expect(result.isErr() && result.error).toBe(last);
    expect(openAttempts()).toBe(3);
  });

  it.each(Object.entries(startsAgainAfter))(
    'starts the sandbox again only for a failure that may pass: %s',
    async (_tag, { mayPass, failure }) => {
      const { open, openAttempts } = setup({ failWith: [failure(), failure(), failure()] });

      const result = await open(new InMemoryRunStore());

      expect(result.isErr()).toBe(true);
      expect(openAttempts()).toBe(mayPass ? 3 : 1);
    },
  );

  it("disposes the run's reporting when the sandbox does not start", async () => {
    const { open, disposals } = setup({ failWith: [new ConfigInvalid(aMessage())] });

    await open(new InMemoryRunStore());

    expect(disposals()).toEqual([{ sessionClosed: false }]);
  });

  it("disposes the run's reporting and passes the panic on when opening the sandbox panics", async () => {
    const bug = new Error(faker.lorem.sentence());
    const { open, disposals } = setup({ openPanic: bug });

    const thrown = await open(new InMemoryRunStore()).catch((error: unknown) => error);

    expect(thrown).toBe(bug);
    expect(disposals()).toHaveLength(1);
  });

  it("closes the opened sandbox before disposing the run's reporting when building the workspace panics", async () => {
    const bug = new Error(faker.lorem.sentence());
    const { open, disposals } = setup({ workspacePanic: bug });

    const thrown = await open(new InMemoryRunStore()).catch((error: unknown) => error);

    expect(thrown).toBe(bug);
    expect(disposals()).toEqual([{ sessionClosed: true }]);
  });

  it("disposes the run's reporting when the scope is disposed", async () => {
    const { open, disposals } = setup({});
    const scope = unwrap(await open(new InMemoryRunStore()));

    await scope.dispose();

    expect(disposals()).toHaveLength(1);
  });

  function setup(input: {
    failWith?: SandboxOpenFailure[];
    openPanic?: Error;
    workspacePanic?: Error;
  }) {
    const session = new FakeAgentSession(faker.system.directoryPath());
    const workspace = new FakeWorkspace(session);
    const events = new RecordingEventSink();
    const startLog = mock<SandboxStartLog>();
    const failures = [...(input.failWith ?? [])];
    const state = { runId: runId(), baseBranch: faker.git.branch(), request: faker.lorem.word() };
    const reportedFor: unknown[] = [];
    const disposals: { sessionClosed: boolean }[] = [];
    let attempts = 0;
    const parts = {
      settings: runSettings({ maxStepRetries: 2, retryDelayMs: 0 }),
      clock: new SteppingClock(),
      log: mock<WarningLog>(),
      reportingFor: (run: RunIdentity, telemetry: RunTelemetry | undefined) => {
        reportedFor.push({ run, telemetry });
        return {
          events,
          log: startLog,
          dispose: async () => {
            disposals.push({ sessionClosed: session.closed });
          },
        };
      },
      openSession: async () => {
        attempts++;
        if (input.openPanic) throw input.openPanic;
        const failure = failures.shift();
        return failure ? Result.err(failure) : Result.ok(session);
      },
      workspaceFor: () => {
        if (input.workspacePanic) throw input.workspacePanic;
        return workspace;
      },
    };
    return {
      open: (store: InMemoryRunStore, telemetry?: RunTelemetry) =>
        acquireRunScope(parts, state, store, telemetry),
      session,
      workspace,
      events,
      startLog,
      reportedFor,
      run: () => ({ runId: state.runId, baseBranch: state.baseBranch }),
      openAttempts: () => attempts,
      disposals: () => disposals,
    };
  }
});

/** Every reason a sandbox may not start; one left out does not compile. */
const startsAgainAfter: {
  [Failure in SandboxOpenFailure as Failure['_tag']]: { mayPass: boolean; failure: () => Failure };
} = {
  SandboxUnavailable: { mayPass: true, failure: sandboxUnavailable },
  SetupCommandFailed: {
    mayPass: true,
    failure: () => new SetupCommandFailed({ ...aMessage(), output: faker.lorem.sentence() }),
  },
  ConfigInvalid: { mayPass: false, failure: () => new ConfigInvalid(aMessage()) },
  SandboxCredentialsInvalid: {
    mayPass: false,
    failure: () => new SandboxCredentialsInvalid(aMessage()),
  },
  SandboxPreparationInvalid: {
    mayPass: false,
    failure: () => new SandboxPreparationInvalid(aMessage()),
  },
  LocalPreparationFailed: { mayPass: false, failure: () => new LocalPreparationFailed(aMessage()) },
};

function aMessage() {
  return { message: faker.lorem.sentence() };
}

function sandboxUnavailable() {
  return new SandboxUnavailable({ message: faker.lorem.sentence() });
}
