import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { aJigConfig, aMetricsSummary, aRunState, runId } from '../../tests/support/builders.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { type JigConfig, runSettingsFrom, validationWarnings } from '../config/load-config.js';
import type { RunId } from '../domain/run-id.js';
import type { RunPhase, RunState } from '../domain/run-state.js';
import { rootCause } from '../failures/messages.js';
import { RunEvents } from '../observers/run-events.js';
import {
  type AgentSession,
  SandboxCredentialsInvalid,
  SandboxPreparationInvalid,
  SandboxUnavailable,
} from '../ports/agent-session.js';
import { GitCommandFailed } from '../ports/git-failures.js';
import type { InvocationRecords } from '../ports/run-records.js';
import { MetricsLogCorrupt, RunInProgress } from '../ports/run-state-failures.js';
import {
  type RunStore,
  type RunStoreCatalog,
  RunStoreOperationFailed,
} from '../ports/run-store.js';
import { ImageBuildFailed } from '../ports/sandbox-images.js';
import type { Workspace } from '../ports/workspace.js';
import { RunRequestInvalid } from './errors.js';
import { invocationRecord } from './invocation-record.js';
import {
  type RunCapabilities,
  runJig,
  type RunLog,
  type RunSandbox,
  type RunScope,
  type StartRequest,
} from './run-jig.js';

describe('runJig over supplied capabilities', () => {
  it('closes the sandbox, disposes the scope, shuts telemetry down and unlocks, in that order, keeping the work failure', async () => {
    const saveFailure = new RunStoreOperationFailed({ message: faker.lorem.sentence() });
    const closeFailure = new SandboxUnavailable({ message: faker.lorem.sentence() });
    const { run, releases, log } = setup({ saved: Result.err(saveFailure), closed: closeFailure });

    const result = await run();

    expect(result.isErr() && result.error).toBe(saveFailure);
    expect(releases()).toEqual(['closeSession', 'dispose', 'shutdown', 'unlock']);
    expect(log.warn.mock.calls.map(([details]) => (details as { err?: unknown }).err)).toContain(
      closeFailure,
    );
  });

  it('releases telemetry and the lock when the sandbox does not start', async () => {
    const openFailure = new SandboxPreparationInvalid({ message: faker.lorem.sentence() });
    const { run, releases } = setup({ opened: openFailure });

    const result = await run();

    expect(result.isErr() && result.error).toBe(openFailure);
    expect(releases()).toEqual(['shutdown', 'unlock']);
  });

  it('releases everything after the work panics and passes the panic on as it was thrown', async () => {
    const bug = new Error(faker.lorem.sentence());
    const { run, releases } = setup({ saveThrows: bug });

    const thrown = await run().catch((error: unknown) => error);

    expect(rootCause(thrown)).toBe(bug);
    expect(releases()).toEqual(['closeSession', 'dispose', 'shutdown', 'unlock']);
  });

  it('refuses a run whose lock another process holds without opening a store or a sandbox', async () => {
    const held = new RunInProgress({ message: faker.lorem.sentence() });
    const { run, capabilities } = setup({ locked: held });

    const result = await run();

    expect(result.isErr() && result.error).toBe(held);
    expect(capabilities.runStores.storeNamed).not.toHaveBeenCalled();
    expect(capabilities.sandbox.openScope).not.toHaveBeenCalled();
  });

  it('refuses missing credentials before preparing the image or starting telemetry, and unlocks', async () => {
    const missing = new SandboxCredentialsInvalid({ message: faker.lorem.sentence() });
    const { run, capabilities, releases } = setup({ credentials: missing });

    const result = await run();

    expect(result.isErr() && result.error).toBe(missing);
    expect(capabilities.sandbox.ensureImage).not.toHaveBeenCalled();
    expect(capabilities.sandbox.startTelemetry).not.toHaveBeenCalled();
    expect(releases()).toEqual(['unlock']);
  });

  it.each(['done', 'stuck', 'completed'] as const)(
    'reports a %s run as it is and records it, without preparing or starting a sandbox',
    async (phase) => {
      const { run, capabilities, state, metrics } = setup({ phase });

      const report = unwrap(await run());

      expect(report).toEqual({ state, status: phase });
      expect(capabilities.sandbox.checkCredentials).not.toHaveBeenCalled();
      expect(capabilities.sandbox.ensureImage).not.toHaveBeenCalled();
      expect(capabilities.sandbox.openScope).not.toHaveBeenCalled();
      expect(capabilities.records.recordInvocation).toHaveBeenCalledWith(
        invocationRecord(state, phase, metrics),
      );
    },
  );

  it('fails with the sandbox that did not close once the work succeeded, and unlocks', async () => {
    const closed = new SandboxUnavailable({ message: faker.lorem.sentence() });
    const { run, releases, capabilities } = setup({ phase: 'gate', checkpoint: true, closed });

    const result = await run();

    expect(result.isErr() && result.error).toBe(closed);
    expect(releases()).toEqual(['closeSession', 'dispose', 'shutdown', 'unlock']);
    expect(capabilities.records.recordInvocation).not.toHaveBeenCalled();
  });

  it('returns a failed branch lookup without saving a run or starting a sandbox', async () => {
    const failure = new GitCommandFailed({
      message: faker.lorem.sentence(),
      command: 'git status',
      output: faker.lorem.sentence(),
    });
    const { start, capabilities, saved, releases } = setup({ unsaved: true });
    capabilities.startingPoint.mockResolvedValue(Result.err(failure));

    const result = await start({ text: faker.lorem.paragraph() });

    expect(result.isErr() && result.error).toBe(failure);
    expect(saved()).toEqual([]);
    expect(capabilities.sandbox.openScope).not.toHaveBeenCalled();
    expect(releases()).toEqual(['unlock']);
  });

  it('saves a new run on the branch and commit it starts from, with the choice not to merge', async () => {
    const { start, capabilities, saved } = setup({
      unsaved: true,
      credentials: new SandboxCredentialsInvalid({ message: faker.lorem.sentence() }),
    });
    const startingPoint = {
      baseBranch: faker.git.branch(),
      startingCommit: faker.git.commitSha(),
    };
    capabilities.startingPoint.mockResolvedValue(Result.ok(startingPoint));
    const text = faker.lorem.paragraph();
    const id = runId();

    await start({ text, merge: false }, id);

    expect(saved()[0]).toMatchObject({ ...startingPoint, runId: id, request: text, merge: false });
  });

  it('names a run after the heading of a request text that has no file', async () => {
    const { start, capabilities } = setup({
      unsaved: true,
      credentials: new SandboxCredentialsInvalid({ message: faker.lorem.sentence() }),
    });
    const heading = faker.string.alpha({ length: 8, casing: 'lower' });

    await start({ text: `# ${heading}\n\n${faker.lorem.paragraph()}` });

    expect(capabilities.lockRun).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${heading}-[0-9a-f]{8}$`)),
    );
  });

  it('keeps the saved choice not to merge when the same request is started again asking to merge', async () => {
    const { start, state } = setup({ phase: 'done', merge: false });

    const report = unwrap(await start({ text: state.request, merge: true }, state.runId));

    expect(report.state.merge).toBe(false);
  });

  it('returns a saved run it cannot load without starting another over it', async () => {
    const failure = new RunStoreOperationFailed({ message: faker.lorem.sentence() });
    const { start, state, saved, releases } = setup({ loadFailure: failure });

    const result = await start({ text: state.request }, state.runId);

    expect(result.isErr() && result.error).toBe(failure);
    expect(saved()).toEqual([]);
    expect(releases()).toEqual(['unlock']);
  });

  it('adopts deferred publication for a run saved before it could defer', async () => {
    const { start, state } = setup({ phase: 'done' });

    const report = unwrap(
      await start({ text: state.request, codePublication: 'deferred' }, state.runId),
    );

    expect(report.state).toEqual({ ...state, codePublication: 'deferred' });
  });

  it('keeps the publication a run recorded when none is asked for', async () => {
    const { run, state } = setup({ phase: 'done', codePublication: 'deferred' });

    expect(unwrap(await run()).state).toEqual(state);
  });

  it('returns metrics it cannot read without recording the invocation', async () => {
    const failure = new MetricsLogCorrupt({ message: faker.lorem.sentence() });
    const { run, capabilities } = setup({ phase: 'done' });
    capabilities.records.metricsSummary.mockReturnValue(Result.err(failure));

    const result = await run();

    expect(result.isErr() && result.error).toBe(failure);
    expect(capabilities.records.recordInvocation).not.toHaveBeenCalled();
  });

  it('refuses to attach a different request to an existing run', async () => {
    const { start, state, releases } = setup();

    const result = await start({ text: faker.lorem.paragraph() }, state.runId);

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
    expect(releases()).toEqual(['unlock']);
  });

  it('refuses to resume a run that does not exist, and unlocks', async () => {
    const { run, releases } = setup({ unsaved: true });

    const result = await run();

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
    expect(releases()).toEqual(['unlock']);
  });

  it('warns about each configuration risk once, before preparing the sandbox image', async () => {
    const { run, capabilities, log, expectedWarnings } = setup({
      config: { mergeMode: 'auto', verifyCommand: undefined },
    });
    const failure = new ImageBuildFailed({
      message: faker.lorem.sentence(),
      output: faker.lorem.sentence(),
    });
    capabilities.sandbox.ensureImage.mockResolvedValue(Result.err(failure));

    const result = await run();

    expect(result.isErr() && result.error).toBe(failure);
    expect(expectedWarnings).not.toEqual([]);
    expect(log.warn.mock.calls).toEqual(expectedWarnings.map((warning) => [warning]));
    expect(log.warn.mock.invocationCallOrder.at(-1)).toBeLessThan(
      capabilities.sandbox.ensureImage.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('warns about a risky configuration when reporting a finished run too', async () => {
    const { run, log, expectedWarnings } = setup({
      phase: 'done',
      config: { mergeMode: 'auto', verifyCommand: undefined },
    });

    unwrap(await run());

    expect(expectedWarnings).not.toEqual([]);
    expect(log.warn.mock.calls).toEqual(expectedWarnings.map((warning) => [warning]));
  });

  it('warns about nothing when the configuration carries no risk', async () => {
    const { run, log } = setup({
      phase: 'done',
      config: {
        implementer: { provider: 'claude', model: 'sonnet' },
        reviewer: { provider: 'claude', model: 'opus' },
        mergeMode: 'manual',
        verifyCommand: `npm run ${faker.word.verb()}`,
      },
    });

    unwrap(await run());

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('opens every configured and required store once, in that order', async () => {
    const configured = [faker.string.uuid(), 'local'];
    const required = ['git-remote', faker.string.uuid()];
    const { capabilities, state } = setup({ phase: 'done', runStores: configured });

    unwrap(
      await runJig(capabilities, {
        start: { text: state.request },
        runId: state.runId,
        requiredStores: [...required, configured[0] ?? ''],
      }),
    );

    expect(capabilities.runStores.storeNamed.mock.calls.map(([name]) => name)).toEqual([
      ...configured,
      ...required,
    ]);
  });

  function setup(
    input: {
      phase?: RunPhase;
      unsaved?: boolean;
      merge?: boolean;
      codePublication?: RunState['codePublication'];
      loadFailure?: RunStoreOperationFailed;
      checkpoint?: boolean;
      config?: Partial<JigConfig>;
      locked?: RunInProgress;
      credentials?: SandboxCredentialsInvalid;
      opened?: SandboxPreparationInvalid;
      closed?: SandboxUnavailable;
      saved?: Result<void, RunStoreOperationFailed>;
      saveThrows?: Error;
      runStores?: string[];
    } = {},
  ) {
    const state = aRunState({
      phase: input.phase ?? 'paused',
      merge: input.merge,
      codePublication: input.codePublication,
    });
    const metrics = aMetricsSummary();
    const savedStates: RunState[] = [];
    const released: string[] = [];
    const store = mock<RunStore>({
      load: async () =>
        input.loadFailure
          ? Result.err(input.loadFailure)
          : Result.ok(input.unsaved ? undefined : state),
      save: async (next) => {
        savedStates.push(next);
        if (input.saveThrows) throw input.saveThrows;
        return input.saved ?? Result.ok();
      },
    });
    const config = aJigConfig({ runStores: input.runStores ?? ['local'], ...input.config });
    const settings = {
      ...runSettingsFrom(config),
      ...(input.checkpoint ? { designGate: 'checkpoint' as const } : {}),
    };
    const scope: RunScope = {
      engineDependencies: {
        ports: { agent: mock<AgentSession>(), workspace: mock<Workspace>() },
        store,
        events: new RunEvents(),
        clock: { now: () => Date.now() },
        settings,
      },
      closeSession: async () => {
        released.push('closeSession');
        return input.closed ? Result.err(input.closed) : Result.ok();
      },
      dispose: async () => {
        released.push('dispose');
      },
    };
    const log = mock<RunLog>();
    const capabilities = {
      config,
      log,
      lockRun: vi.fn<RunCapabilities['lockRun']>(async () =>
        input.locked
          ? Result.err(input.locked)
          : Result.ok(async () => {
              released.push('unlock');
            }),
      ),
      runStores: mock<RunStoreCatalog>({
        storeNamed: vi.fn(async () => Result.ok(store)),
        combined: () => store,
      }),
      startingPoint: vi.fn<RunCapabilities['startingPoint']>(async () =>
        Result.ok({ baseBranch: 'main', startingCommit: faker.git.commitSha() }),
      ),
      records: mock<InvocationRecords>({
        metricsSummary: vi.fn<InvocationRecords['metricsSummary']>(() => Result.ok(metrics)),
        recordInvocation: vi.fn(async () => Result.ok()),
      }),
      sandbox: mock<RunSandbox>({
        checkCredentials: vi.fn(() =>
          input.credentials ? Result.err(input.credentials) : Result.ok(),
        ),
        ensureImage: vi.fn<RunSandbox['ensureImage']>(async () => Result.ok()),
        startTelemetry: vi.fn(async () => ({
          observer: { handle: () => {} },
          shutdown: async () => {
            released.push('shutdown');
          },
        })),
        openScope: vi.fn(async () => (input.opened ? Result.err(input.opened) : Result.ok(scope))),
      }),
    } satisfies RunCapabilities;
    return {
      state,
      metrics,
      log,
      capabilities,
      releases: () => released,
      saved: () => savedStates,
      expectedWarnings: validationWarnings(config),
      start: (request: StartRequest, id?: RunId) =>
        runJig(capabilities, { start: request, runId: id }),
      run: () => runJig(capabilities, { resume: state.runId }),
    };
  }
});
