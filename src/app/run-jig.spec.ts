import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { panic, Result } from 'better-result';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { simpleGit } from 'simple-git';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  aDescription,
  approval,
  designApproval,
  designFindings,
  designRevision,
  fulfillment,
  scriptPlanning,
  scriptWholeRun,
} from '../../tests/support/agent-scripts.js';
import {
  aContext,
  aDesignFinding,
  aDisposition,
  aFeaturePlan,
  aJigConfig,
  aMetricsSummary,
  aPlannedSlice,
  aRunState,
  designDocs,
  everyStepOn,
  implementingPlanSteps,
  runId,
} from '../../tests/support/builders.js';
import { type AgentScript, FakeAgentSession } from '../../tests/support/fakes.js';
import { openRunWorktree, sandboxCloneOf } from '../../tests/support/open-run-worktree.js';
import { realStatusCapabilities } from '../../tests/support/repository-sources.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { configDestination } from '../adapters/filesystem/config-source.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { lockRun } from '../adapters/local-store/run-lock.js';
import { stateDirectory } from '../adapters/local-store/run-paths.js';
import { DOCKERFILE, SANDBOX_DIRECTORY } from '../adapters/sandbox-image/image-recipe.js';
import type { OpenSessionInput } from '../adapters/sandcastle/open-session.js';
import type { SessionOpenFailure } from '../adapters/sandcastle/sandcastle-session.js';
import { parseEnvironment } from '../config/environment.js';
import { type JigConfig, runSettingsFrom, validationWarnings } from '../config/load-config.js';
import { designReviewStage } from '../domain/design-review.js';
import { designReviewReport } from '../domain/design-review-report.js';
import { type RunId, runIdSchema } from '../domain/run-id.js';
import { runBranchFor, type RunPhase } from '../domain/run-state.js';
import { rootCause } from '../failures/messages.js';
import { RunEvents } from '../observers/run-events.js';
import {
  type AgentSession,
  SandboxCredentialsInvalid,
  SandboxPreparationInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
} from '../ports/agent-session.js';
import { GitCommandFailed } from '../ports/git-failures.js';
import { LocalStateUnwritable } from '../ports/local-state.js';
import type { InvocationRecords } from '../ports/run-records.js';
import { RunInProgress } from '../ports/run-state-failures.js';
import {
  type RunStore,
  type RunStoreCatalog,
  RunStoreOperationFailed,
} from '../ports/run-store.js';
import { ImageBuildFailed, type SandboxImages } from '../ports/sandbox-images.js';
import type { Workspace } from '../ports/workspace.js';
import { createAppContainer, runCapabilitiesOf } from './container.js';
import { RunRequestInvalid } from './errors.js';
import {
  type RunCapabilities,
  runJig,
  type RunLog,
  type RunSandbox,
  type RunScope,
} from './run-jig.js';
import { readRunStatus } from './run-status.js';

/** TEST-NET-1: routable nowhere, so an exporter aimed at it waits out its timeout. */
const UNREACHABLE_COLLECTOR = 'http://192.0.2.1:4318';

describe('runJig', () => {
  it('preserves a failed branch lookup before opening a sandbox', async () => {
    const { app, sessionsOpened } = await setup();
    const directory = await tempDirectory();
    app.register({ repoRoot: asValue(directory) });

    const result = await runJig(runCapabilitiesOf(app), {
      start: { text: faker.lorem.paragraph() },
      runId: runId(),
    });

    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toBeInstanceOf(GitCommandFailed);
    expect(result.isErr() && GitCommandFailed.is(result.error) && result.error.command).toBe(
      'git status',
    );
    expect(sessionsOpened()).toBe(0);
  });

  it('starts a run from a request and stops once the work waits to be merged', async () => {
    const { app, aRequest, agentFor, repo } = await setup();
    const id = runId();
    const agent = agentFor(id);
    scriptWholeRun(agent);

    const report = (
      await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(report).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
    expect(agent.closed).toBe(true);
    expect(await readResult(repo.dir, id)).toMatchObject({ status: 'halted', complete: false });
  });

  it('starts a run that skips the merge, saves the choice and ends it completed', async () => {
    const { app, aRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));

    const report = (
      await runJig(runCapabilitiesOf(app), { start: { text: aRequest(), merge: false }, runId: id })
    ).unwrap();

    expect(report).toMatchObject({ status: 'completed', state: { phase: 'completed' } });
    expect((await new LocalRunStore(repo.dir).load(id)).unwrap()?.merge).toBe(false);
    expect(await readResult(repo.dir, id)).toMatchObject({ status: 'completed', complete: true });
  });

  it('keeps the saved choice not to merge when the run is started again asking to merge', async () => {
    const { app, aRequest, agentFor } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const request = aRequest();
    (
      await runJig(runCapabilitiesOf(app), { start: { text: request, merge: false }, runId: id })
    ).unwrap();

    const second = (
      await runJig(runCapabilitiesOf(app), { start: { text: request, merge: true }, runId: id })
    ).unwrap();

    expect(second).toMatchObject({ status: 'completed', state: { merge: false } });
  });

  it('reports a saved completed run without opening a sandbox', async () => {
    const { app, repo, sessionsOpened } = await setup();
    const state = aRunState({ phase: 'completed', merge: false });
    await new LocalRunStore(repo.dir).save(state);

    const report = (await runJig(runCapabilitiesOf(app), { resume: state.runId })).unwrap();

    expect(report.status).toBe('completed');
    expect(sessionsOpened()).toBe(0);
  });

  it("leaves a tracked file alone when a saved run's document links to it", async () => {
    const { app, repo } = await setup();
    const id = runId();
    const stateDir = stateDirectory(repo.dir, id);
    const tracked = path.join(repo.dir, 'README.md');
    const original = await readFile(tracked, 'utf-8');
    await mkdir(stateDir, { recursive: true });
    await new LocalRunStore(repo.dir).save(aRunState({ runId: id, phase: 'done' }));
    await symlink(tracked, path.join(stateDir, 'design.md'));

    const refusal = await runJig(runCapabilitiesOf(app), { resume: id });

    expect(await readFile(tracked, 'utf-8')).toBe(original);
    expect(refusal.isErr() && refusal.error).toBeInstanceOf(LocalStateUnwritable);
  });

  it("ignores telemetry settings in the process environment that the app wasn't given", async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', UNREACHABLE_COLLECTOR);
    const { app, aRequest, agentFor } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));

    const report = (
      await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(report).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
  });

  it('resumes by id and finishes once a person has merged the run branch', async () => {
    const { app, aRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    (await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id })).unwrap();
    await simpleGit({ baseDir: repo.dir }).merge([runBranchFor(id), '--no-edit']);

    const report = (await runJig(runCapabilitiesOf(app), { resume: id })).unwrap();

    expect(report.status).toBe('done');
    expect(await readResult(repo.dir, id)).toMatchObject({ status: 'done', complete: true });
  });

  it('resumes instead of starting over when given the same request and id again', async () => {
    const { app, aRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const request = aRequest();
    const first = (
      await runJig(runCapabilitiesOf(app), { start: { text: request }, runId: id })
    ).unwrap();
    const commitsAfterFirst = await runBranchCommits(repo.dir, id);

    const second = (
      await runJig(runCapabilitiesOf(app), { start: { text: request }, runId: id })
    ).unwrap();

    expect(second).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
    expect(second.state.runId).toBe(id);
    expect(second.state.plan).toEqual(first.state.plan);
    expect(second.state.slices).toEqual(first.state.slices);
    const saved = (await new LocalRunStore(repo.dir).load(id)).unwrap();
    expect(saved?.phase).toBe('awaitingMerge');
    expect(saved?.slices).toEqual(first.state.slices);
    expect(await runBranchCommits(repo.dir, id)).toEqual(commitsAfterFirst);
  });

  it('refuses a second run of the same id while the first is going, and runs it once that one stops', async () => {
    const { app, aRequest, agentFor, holdNextSession } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const request = aRequest();
    const held = holdNextSession();
    const first = runJig(runCapabilitiesOf(app), { start: { text: request }, runId: id });
    await held.opened;

    const refused = await runJig(runCapabilitiesOf(app), { start: { text: request }, runId: id });

    expect(refused.isErr() && refused.error).toBeInstanceOf(RunInProgress);

    held.release();
    await first;
    expect((await runJig(runCapabilitiesOf(app), { resume: id })).unwrap()).toMatchObject({
      state: { phase: 'awaitingMerge' },
    });
  });

  it('starts the sandbox again when it failed for a reason that may pass', async () => {
    const { app, aRequest, agentFor, failNextSessions } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const opened = failNextSessions(
      new SandboxUnavailable({ message: faker.lorem.sentence() }),
      new SetupCommandFailed({
        message: faker.lorem.sentence(),
        output: faker.lorem.sentence(),
      }),
    );

    const report = (
      await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(report.state.phase).toBe('awaitingMerge');
    expect(opened()).toBe(3);
  });

  it('stops at once when the sandbox cannot start because of its configuration', async () => {
    const { app, aRequest, agentFor, failNextSessions } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const opened = failNextSessions(
      new SandboxPreparationInvalid({ message: faker.lorem.sentence() }),
    );

    const result = await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id });

    expect(result.isErr() && result.error).toBeInstanceOf(SandboxPreparationInvalid);
    expect(opened()).toBe(1);
  });

  it('refuses to attach a different request to an existing run', async () => {
    const { app, aRequest, agentFor } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    (await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id })).unwrap();

    const result = await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id });

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
  });

  it('refuses to resume a run that does not exist', async () => {
    const { app } = await setup();

    const result = await runJig(runCapabilitiesOf(app), { resume: runId() });

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
  });

  it('releases the run lock when the run fails', async () => {
    const { app, repo } = await setup();
    const id = runId();

    const failed = await runJig(runCapabilitiesOf(app), { resume: id });

    expect(failed.isErr() && failed.error).toBeInstanceOf(RunRequestInvalid);
    const release = (await lockRun(repo.dir, id)).unwrap();
    await release();
  });

  it('starts a run named after the heading of a request text that has no file', async () => {
    const { app, repo, failNextSessions } = await setup();
    failNextSessions(new SandboxPreparationInvalid({ message: faker.lorem.sentence() }));
    const heading = faker.string.alpha({ length: 8, casing: 'lower' });

    await runJig(runCapabilitiesOf(app), {
      start: { text: `# ${heading}\n\n${faker.lorem.paragraph()}` },
    });

    expect(await readdir(path.join(repo.dir, '.jig'))).toContainEqual(
      expect.stringMatching(new RegExp(`^${heading}-[0-9a-f]{8}$`)),
    );
  });

  it.each(['done', 'stuck'] as const)(
    'returns a %s run as it is, without building an image or starting a sandbox',
    async (phase) => {
      const { app, repo, sessionsOpened } = await setup({ managedImage: true });
      const state = aRunState({ phase });
      await new LocalRunStore(repo.dir).save(state);

      const report = (await runJig(runCapabilitiesOf(app), { resume: state.runId })).unwrap();

      expect(report).toMatchObject({ status: phase, state: { phase } });
      expect(sessionsOpened()).toBe(0);
    },
  );

  it('warns about each configuration risk once per invocation, however many slices it runs', async () => {
    const { app, aRequest, agentFor, warnings } = await setup({
      config: { mergeMode: 'auto', verifyCommand: undefined },
    });
    const id = runId();
    scriptTwoSliceRun(agentFor(id));
    const request = aRequest();
    const expected = validationWarnings(app.cradle.config);

    const first = (
      await runJig(runCapabilitiesOf(app), { start: { text: request }, runId: id })
    ).unwrap();

    expect(first.state.slices).toHaveLength(2);
    expect(expected).toHaveLength(2);
    expect(warnings()).toEqual(expected);

    (await runJig(runCapabilitiesOf(app), { start: { text: request }, runId: id })).unwrap();

    expect(warnings()).toEqual([...expected, ...expected]);
  });

  it('warns about the configuration before preparing the sandbox image', async () => {
    const { app, aRequest, agentFor, repo, logger, images } = await setup({
      managedImage: true,
      config: { mergeMode: 'auto', verifyCommand: undefined },
    });
    const id = runId();
    scriptWholeRun(agentFor(id));
    await mkdir(path.join(repo.dir, SANDBOX_DIRECTORY), { recursive: true });
    await writeFile(
      path.join(repo.dir, SANDBOX_DIRECTORY, DOCKERFILE),
      `FROM ${faker.word.noun()}`,
    );
    images.labels.mockResolvedValue(
      Result.err(
        new ImageBuildFailed({ message: faker.lorem.sentence(), output: faker.lorem.sentence() }),
      ),
    );

    const result = await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id });

    expect(result.isErr() && result.error).toBeInstanceOf(ImageBuildFailed);
    expect(logger.warn).toHaveBeenCalledTimes(validationWarnings(app.cradle.config).length);
    expect(logger.warn.mock.invocationCallOrder[0]).toBeLessThan(
      images.labels.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('warns when reporting a finished run, without preparing an image or a sandbox', async () => {
    const { app, repo, warnings, images, sessionsOpened } = await setup({
      managedImage: true,
      config: { mergeMode: 'auto', verifyCommand: undefined },
    });
    const state = aRunState({ phase: 'done' });
    await new LocalRunStore(repo.dir).save(state);

    (await runJig(runCapabilitiesOf(app), { resume: state.runId })).unwrap();

    expect(warnings()).toEqual(validationWarnings(app.cradle.config));
    expect(warnings()).not.toEqual([]);
    expect(images.labels).not.toHaveBeenCalled();
    expect(sessionsOpened()).toBe(0);
  });

  it('warns about nothing when the configuration carries no risk', async () => {
    const { app, aRequest, agentFor, warnings } = await setup({
      config: {
        implementer: { provider: 'claude', model: 'sonnet' },
        reviewer: { provider: 'claude', model: 'opus' },
        mergeMode: 'manual',
        verifyCommand: `npm run ${faker.word.verb()}`,
      },
    });
    const id = runId();
    scriptWholeRun(agentFor(id));

    const report = (
      await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(report.status).toBe('halted');
    expect(warnings()).toEqual([]);
  });

  it('exports the approved design review beside the design and plan it approved', async () => {
    const { app, aRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));

    const { state } = (
      await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(designReviewStage(state)).toBe('approved');
    expect(await readDocument(repo.dir, id, 'design-review.md')).toBe(designReviewReport(state));
    expect(await readDocument(repo.dir, id, 'design.md')).toBe(state.docs?.design);
  });

  it('pauses at the checkpoint with the revised documents exported and the originals in the report', async () => {
    const { app, aRequest, agentFor, repo } = await setup({
      config: { designGate: 'checkpoint' },
    });
    const id = runId();
    const agent = agentFor(id);
    const { written, revised } = scriptRevisedDesign(agent, designApproval());
    agent.script('planner', {
      output: [aPlannedSlice({ description: implementingPlanSteps(1) })],
    });

    const report = (
      await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(report).toMatchObject({ status: 'halted', state: { phase: 'paused' } });
    expect(designReviewStage(report.state)).toBe('approved');
    expect(await readDocument(repo.dir, id, 'design.md')).toBe(revised.design);
    expect(await readDocument(repo.dir, id, 'plan.md')).toBe(revised.plan);
    const exported = await readDocument(repo.dir, id, 'design-review.md');
    expect(exported).toBe(designReviewReport(report.state));
    expect(exported).toContain(written.design);
    expect(report.state.designReview?.revision?.reviewedDocs).toEqual(written);
  });

  it('blocks on findings left after the revision, naming them in the result, the report and the status', async () => {
    const { app, aRequest, agentFor, repo } = await setup();
    const id = runId();
    const outstanding = aDesignFinding({ resolution: 'operatorDecision' });
    scriptRevisedDesign(agentFor(id), designFindings(outstanding));

    const report = (
      await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(report).toMatchObject({ status: 'blocked', state: { phase: 'resolvingDesign' } });
    expect((await readResult(repo.dir, id)).blockedReason).toContain(outstanding.id);
    const exported = await readDocument(repo.dir, id, 'design-review.md');
    expect(exported).toBe(designReviewReport(report.state));
    for (const evidence of outstanding.evidence) expect(exported).toContain(evidence);
    const status = unwrap(await readRunStatus(realStatusCapabilities(repo.dir), { runId: id }));
    expect(status.state.blockedReason).toContain(outstanding.id);
    expect(status.documents.map((document) => document.name)).toContain('design-review.md');
  });

  it('keeps the review done so far when the re-review reply is invalid, without reading as approved', async () => {
    const { app, aRequest, agentFor, repo } = await setup();
    const id = runId();
    const malformed = { output: { verdict: faker.lorem.word() } };
    const { finding, revised } = scriptRevisedDesign(agentFor(id), malformed, malformed, malformed);

    const report = (
      await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(report).toMatchObject({ status: 'blocked', state: { phase: 'reviewingDesign' } });
    expect(designReviewStage(report.state)).toBe('awaitingReReview');
    const exported = await readDocument(repo.dir, id, 'design-review.md');
    expect(exported).toBe(designReviewReport(report.state));
    expect(exported).toContain(finding.failureScenario);
    expect(await readDocument(repo.dir, id, 'design.md')).toBe(revised.design);
  });

  it("counts the design reviewer's and planner's calls and steps in the run's metrics", async () => {
    const { app, aRequest, agentFor, repo } = await setup();
    const id = runId();
    const agent = agentFor(id);
    scriptRevisedDesign(agent, designFindings(aDesignFinding()));

    (await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id })).unwrap();

    const records = unwrap(new MetricsLog(repo.dir, id).readAll());
    const rolesCalledIn = (phase: RunPhase) =>
      records.flatMap((record) =>
        record.kind === 'agentCall' && record.location?.phase === phase ? [record.role] : [],
      );
    expect(rolesCalledIn('reviewingDesign')).toEqual(['reviewer', 'reviewer']);
    expect(rolesCalledIn('revisingDesign')).toEqual(['planner']);
    const steps = records.filter((record) => record.kind === 'step');
    expect(steps.map((step) => step.location.phase)).toEqual([
      'context',
      'planning',
      'designing',
      'reviewingDesign',
      'revisingDesign',
      'reviewingDesign',
    ]);
    const { metrics } = await readResult(repo.dir, id);
    expect(metrics.agentCalls).toBe(agent.usage.length);
    expect(metrics.tokens.input).toBe(sum(agent.usage.map((usage) => usage.tokens.input)));
    expect(metrics.costUsd).toBeCloseTo(sum(agent.usage.map((usage) => usage.costUsd)));
    expect(metrics.durationMs).toBe(sum(steps.map((step) => step.durationMs)));
  });

  it('fails with the sandbox that did not close once the run itself succeeded, and releases the lock', async () => {
    const { app, aRequest, agentFor, repo } = await setup();
    const id = runId();
    const agent = agentFor(id);
    scriptWholeRun(agent);
    const closeFailure = new SandboxUnavailable({ message: faker.lorem.sentence() });
    agent.failCloseWith = closeFailure;

    const result = await runJig(runCapabilitiesOf(app), { start: { text: aRequest() }, runId: id });

    expect(result.isErr() && result.error).toBe(closeFailure);
    await unwrap(await lockRun(repo.dir, id))();
  });

  it('keeps the failure saving to a custom store over a sandbox that did not close, and logs the close', async () => {
    const { repo, ...prepared } = await setup();
    const storeModule = `${faker.string.uuid()}.mjs`;
    await writeFile(
      path.join(repo.dir, storeModule),
      `let saves = 0;
       export default () => ({
         load: async () => undefined,
         save: async () => { if (++saves > 1) throw new Error('store is full'); },
       });`,
    );
    prepared.app.register({
      config: asValue({ ...prepared.app.cradle.config, runStores: [storeModule] }),
    });
    const id = runId();
    const agent = prepared.agentFor(id);
    scriptWholeRun(agent);
    const closeFailure = new SandboxUnavailable({ message: faker.lorem.sentence() });
    agent.failCloseWith = closeFailure;

    const result = await runJig(runCapabilitiesOf(prepared.app), {
      start: { text: prepared.aRequest() },
      runId: id,
    });

    expect(result.isErr() && result.error).toBeInstanceOf(RunStoreOperationFailed);
    expect(agent.closed).toBe(true);
    expect(prepared.loggedFailures()).toContain(closeFailure);
  });

  it('closes the sandbox and releases the lock when the work crashes, passing the crash on', async () => {
    const { app, aRequest, agentFor, repo } = await setup();
    const id = runId();
    const crash = new Error(faker.lorem.sentence());
    const agent = agentFor(id).script('planner', { crash });

    const thrown = await runJig(runCapabilitiesOf(app), {
      start: { text: aRequest() },
      runId: id,
    }).catch((error: unknown) => error);

    expect(rootCause(thrown)).toBe(crash);
    expect(agent.closed).toBe(true);
    await unwrap(await lockRun(repo.dir, id))();
  });

  async function setup(
    options: {
      managedImage?: boolean;
      environment?: NodeJS.ProcessEnv;
      config?: Partial<JigConfig>;
    } = {},
  ) {
    const repo = await createTempRepo();

    const app = createAppContainer({
      repoRoot: repo.dir,
      configDestination: configDestination(repo.dir),
      logFormat: 'json',
      logLevel: 'silent',
      environment: unwrap(
        parseEnvironment(
          options.environment ?? { ANTHROPIC_API_KEY: faker.string.alphanumeric(20) },
          faker.system.directoryPath(),
        ),
      ),
      config: aJigConfig(),
    });
    const agents = new Map<string, FakeAgentSession>();
    const agentFor = (id: string) => {
      const agent = new FakeAgentSession(
        sandboxCloneOf(repo.dir, runIdSchema.parse(id)),
        undefined,
        path.join(repo.dir, '.jig', id, 'workspace'),
      );
      agents.set(id, agent);
      return agent;
    };
    let held: { opened: () => void; released: Promise<void> } | undefined;
    const holdNextSession = () => {
      let release = () => {};
      let opened = () => {};
      const openedPromise = new Promise<void>((resolve) => (opened = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      held = { opened, released };
      return { opened: openedPromise, release };
    };
    let sessionFailures: SessionOpenFailure[] = [];
    let sessionsOpened = 0;
    const failNextSessions = (...failures: SessionOpenFailure[]) => {
      sessionFailures = failures;
      return () => sessionsOpened;
    };
    const sandboxImage = options.managedImage ? undefined : `sandcastle:${faker.word.noun()}`;
    app.register({
      config: asValue(aJigConfig({ ...everyStepOn(), sandboxImage, ...options.config })),
    });
    const logger = mock<Logger>();
    const images = mock<SandboxImages>();
    app.register({
      settings: asValue({ ...app.cradle.settings, retryDelayMs: 0 }),
      logger: asValue(logger),
      images: asValue(images),
      openSession: asValue(async ({ run, events }: OpenSessionInput) => {
        sessionsOpened++;
        const failure = sessionFailures.shift();
        if (failure) return Result.err(failure);
        const agent = agents.get(run.runId);
        if (!agent) panic(`No fake agent prepared for run ${run.runId}`);
        const holding = held;
        held = undefined;
        holding?.opened();
        await holding?.released;
        await openRunWorktree({ repoRoot: repo.dir, ...run });
        return Result.ok(agent.reportUsageTo(events, run.runId));
      }),
    });
    const aRequest = () => `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`;
    return {
      app,
      repo,
      aRequest,
      agentFor,
      holdNextSession,
      failNextSessions,
      sessionsOpened: () => sessionsOpened,
      logger,
      images,
      warnings: () => logger.warn.mock.calls.map(([message]) => message),
      loggedFailures: () =>
        logger.warn.mock.calls.map(([details]) => (details as { err?: unknown }).err),
    };
  }
});

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

  it('reports an ended run as it is and records it, without preparing or starting a sandbox', async () => {
    const { run, capabilities, state } = setup({ phase: 'done' });

    const report = unwrap(await run());

    expect(report).toEqual({ state, status: 'done' });
    expect(capabilities.sandbox.checkCredentials).not.toHaveBeenCalled();
    expect(capabilities.sandbox.openScope).not.toHaveBeenCalled();
    expect(capabilities.records.recordInvocation).toHaveBeenCalledWith(
      state,
      'done',
      expect.anything(),
    );
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
      phase?: 'paused' | 'done';
      locked?: RunInProgress;
      credentials?: SandboxCredentialsInvalid;
      opened?: SandboxPreparationInvalid;
      closed?: SandboxUnavailable;
      saved?: Result<void, RunStoreOperationFailed>;
      saveThrows?: Error;
      runStores?: string[];
    } = {},
  ) {
    const state = aRunState({ phase: input.phase ?? 'paused' });
    const released: string[] = [];
    const store = mock<RunStore>({
      load: async () => Result.ok(state),
      save: async () => {
        if (input.saveThrows) throw input.saveThrows;
        return input.saved ?? Result.ok();
      },
    });
    const config = aJigConfig({ runStores: input.runStores ?? ['local'] });
    const settings = runSettingsFrom(config);
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
      startingPoint: vi.fn<RunCapabilities['startingPoint']>(),
      records: mock<InvocationRecords>({
        metricsSummary: () => Result.ok(aMetricsSummary()),
        recordInvocation: vi.fn(async () => Result.ok()),
      }),
      sandbox: mock<RunSandbox>({
        checkCredentials: vi.fn(() =>
          input.credentials ? Result.err(input.credentials) : Result.ok(),
        ),
        ensureImage: vi.fn(async () => Result.ok()),
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
      log,
      capabilities,
      releases: () => released,
      run: () => runJig(capabilities, { resume: state.runId }),
    };
  }
});

function scriptTwoSliceRun(agent: FakeAgentSession) {
  const slices = [1, 1].map((step) => aPlannedSlice({ description: implementingPlanSteps(step) }));
  scriptPlanning(agent, slices);
  agent.script(
    'implementer',
    ...slices.map((slice) => ({ files: { [`${slice.id}.txt`]: faker.lorem.sentence() } })),
  );
  agent.script('reviewer', approval(), approval(), fulfillment());
  agent.script('describer', aDescription());
}

async function runBranchCommits(repoRoot: string, id: RunId) {
  const log = await simpleGit({ baseDir: repoRoot }).log([`main..${runBranchFor(id)}`]);
  return log.all.map((commit) => commit.hash);
}

function scriptRevisedDesign(agent: FakeAgentSession, ...reReview: AgentScript[]) {
  const written = designDocs();
  const revised = designDocs();
  const finding = aDesignFinding();
  agent.script(
    'planner',
    { output: aContext() },
    { output: aFeaturePlan() },
    { output: written },
    designRevision(revised, [aDisposition(finding)]),
  );
  agent.script('reviewer', designFindings(finding), ...reReview);
  return { written, revised, finding };
}

async function readDocument(repoRoot: string, id: RunId, name: string) {
  return readFile(path.join(stateDirectory(repoRoot, id), name), 'utf-8');
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

async function readResult(repoRoot: string, id: RunId) {
  return JSON.parse(
    await readFile(path.join(stateDirectory(repoRoot, id), 'result.json'), 'utf-8'),
  );
}
