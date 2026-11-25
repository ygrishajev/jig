import { faker } from '@faker-js/faker';
import { panic, Result } from 'better-result';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { simpleGit } from 'simple-git';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  designFindings,
  designRevision,
  scriptWholeRun,
} from '../../tests/support/agent-scripts.js';
import {
  aContext,
  aDesignFinding,
  aDisposition,
  aFeaturePlan,
  aJigConfig,
  aRunState,
  designDocs,
  everyStepOn,
  runId,
} from '../../tests/support/builders.js';
import {
  type AgentScript,
  FakeAgentSession,
  InMemoryPresetSource,
} from '../../tests/support/fakes.js';
import { openRunWorktree, sandboxCloneOf } from '../../tests/support/open-run-worktree.js';
import { realStatusCapabilities } from '../../tests/support/repository-sources.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { configDestination, configFileSource } from '../adapters/filesystem/config-source.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { MetricsLog } from '../adapters/local-store/metrics-log.js';
import { stateDirectory } from '../adapters/local-store/run-paths.js';
import { runRuntimeFactory } from '../composition/run-runtime.js';
import { parseEnvironment } from '../config/environment.js';
import { type JigConfig, runSettingsFrom } from '../config/load-config.js';
import { designReviewStage } from '../domain/design-review.js';
import { designReviewReport } from '../domain/design-review-report.js';
import { type RunId, runIdSchema } from '../domain/run-id.js';
import { runBranchFor, type RunPhase } from '../domain/run-state.js';
import {
  SandboxPreparationInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
} from '../ports/agent-session.js';
import { LocalStateUnwritable } from '../ports/local-state.js';
import { RunInProgress } from '../ports/run-state-failures.js';
import { type SandboxImages } from '../ports/sandbox-images.js';
import { runJig } from './run-jig.js';
import type { RuntimeRequest } from './run-operation.js';
import { readRunStatus } from './run-status.js';
import type { SandboxOpenFailure } from './sandbox-runtime.js';

/** TEST-NET-1: routable nowhere, so an exporter aimed at it waits out its timeout. */
const UNREACHABLE_COLLECTOR = 'http://192.0.2.1:4318';

describe('runJig', () => {
  it('starts a run from a request and stops once the work waits to be merged', async () => {
    const { capabilities, aRequest, agentFor, repo } = await setup();
    const id = runId();
    const agent = agentFor(id);
    scriptWholeRun(agent);

    const report = (
      await runJig(capabilities(), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(report).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
    expect(agent.closed).toBe(true);
    expect(await readResult(repo.dir, id)).toMatchObject({ status: 'halted', complete: false });
    const status = unwrap(await readRunStatus(realStatusCapabilities(repo.dir), { runId: id }));
    expect(await readDocument(repo.dir, id, 'PR_DESCRIPTION.md')).toContain(status.metricsLine);
  });

  it("leaves a tracked file alone when a saved run's document links to it", async () => {
    const { capabilities, repo } = await setup();
    const id = runId();
    const stateDir = stateDirectory(repo.dir, id);
    const tracked = path.join(repo.dir, 'README.md');
    const original = await readFile(tracked, 'utf-8');
    await mkdir(stateDir, { recursive: true });
    await new LocalRunStore(repo.dir).save(aRunState({ runId: id, phase: 'done' }));
    await symlink(tracked, path.join(stateDir, 'design.md'));

    const refusal = await runJig(capabilities(), { resume: id });

    expect(await readFile(tracked, 'utf-8')).toBe(original);
    expect(refusal.isErr() && refusal.error).toBeInstanceOf(LocalStateUnwritable);
  });

  it("ignores telemetry settings in the process environment that the app wasn't given", async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', UNREACHABLE_COLLECTOR);
    const { capabilities, aRequest, agentFor } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));

    const report = (
      await runJig(capabilities(), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(report).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
  });

  it('resumes by id and finishes once a person has merged the run branch', async () => {
    const { capabilities, aRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    (await runJig(capabilities(), { start: { text: aRequest() }, runId: id })).unwrap();
    await simpleGit({ baseDir: repo.dir }).merge([runBranchFor(id), '--no-edit']);

    const report = (await runJig(capabilities(), { resume: id })).unwrap();

    expect(report.status).toBe('done');
    expect(await readResult(repo.dir, id)).toMatchObject({ status: 'done', complete: true });
  });

  it('resumes instead of starting over when given the same request and id again', async () => {
    const { capabilities, aRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const request = aRequest();
    const first = (await runJig(capabilities(), { start: { text: request }, runId: id })).unwrap();
    const commitsAfterFirst = await runBranchCommits(repo.dir, id);

    const second = (await runJig(capabilities(), { start: { text: request }, runId: id })).unwrap();

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
    const { capabilities, aRequest, agentFor, holdNextSession } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const request = aRequest();
    const held = holdNextSession();
    const first = runJig(capabilities(), { start: { text: request }, runId: id });
    await held.opened;

    const refused = await runJig(capabilities(), { start: { text: request }, runId: id });

    expect(refused.isErr() && refused.error).toBeInstanceOf(RunInProgress);

    held.release();
    await first;
    expect((await runJig(capabilities(), { resume: id })).unwrap()).toMatchObject({
      state: { phase: 'awaitingMerge' },
    });
  });

  it('starts the sandbox again when it failed for a reason that may pass', async () => {
    const { capabilities, aRequest, agentFor, failNextSessions } = await setup();
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
      await runJig(capabilities(), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(report.state.phase).toBe('awaitingMerge');
    expect(opened()).toBe(3);
  });

  it('stops at once when the sandbox cannot start because of its configuration', async () => {
    const { capabilities, aRequest, agentFor, failNextSessions } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const opened = failNextSessions(
      new SandboxPreparationInvalid({ message: faker.lorem.sentence() }),
    );

    const result = await runJig(capabilities(), { start: { text: aRequest() }, runId: id });

    expect(result.isErr() && result.error).toBeInstanceOf(SandboxPreparationInvalid);
    expect(opened()).toBe(1);
  });

  it('exports the approved design review beside the design and plan it approved', async () => {
    const { capabilities, aRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));

    const { state } = (
      await runJig(capabilities(), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(designReviewStage(state)).toBe('approved');
    expect(await readDocument(repo.dir, id, 'design-review.md')).toBe(designReviewReport(state));
    expect(await readDocument(repo.dir, id, 'design.md')).toBe(state.docs?.design);
  });

  it('blocks on findings left after the revision, naming them in the result, the report and the status', async () => {
    const { capabilities, aRequest, agentFor, repo } = await setup();
    const id = runId();
    const outstanding = aDesignFinding({ resolution: 'operatorDecision' });
    scriptRevisedDesign(agentFor(id), designFindings(outstanding));

    const report = (
      await runJig(capabilities(), { start: { text: aRequest() }, runId: id })
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
    const { capabilities, aRequest, agentFor, repo } = await setup();
    const id = runId();
    const malformed = { output: { verdict: faker.lorem.word() } };
    const { finding, revised } = scriptRevisedDesign(agentFor(id), malformed, malformed, malformed);

    const report = (
      await runJig(capabilities(), { start: { text: aRequest() }, runId: id })
    ).unwrap();

    expect(report).toMatchObject({ status: 'blocked', state: { phase: 'reviewingDesign' } });
    expect(designReviewStage(report.state)).toBe('awaitingReReview');
    const exported = await readDocument(repo.dir, id, 'design-review.md');
    expect(exported).toBe(designReviewReport(report.state));
    expect(exported).toContain(finding.failureScenario);
    expect(await readDocument(repo.dir, id, 'design.md')).toBe(revised.design);
  });

  it("counts the design reviewer's and planner's calls and steps in the run's metrics", async () => {
    const { capabilities, aRequest, agentFor, repo } = await setup();
    const id = runId();
    const agent = agentFor(id);
    scriptRevisedDesign(agent, designFindings(aDesignFinding()));

    (await runJig(capabilities(), { start: { text: aRequest() }, runId: id })).unwrap();

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

  async function setup(
    options: {
      managedImage?: boolean;
      environment?: NodeJS.ProcessEnv;
      config?: Partial<JigConfig>;
    } = {},
  ) {
    const repo = await createTempRepo();

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
    let sessionFailures: SandboxOpenFailure[] = [];
    let sessionsOpened = 0;
    const failNextSessions = (...failures: SandboxOpenFailure[]) => {
      sessionFailures = failures;
      return () => sessionsOpened;
    };
    const sandboxImage = options.managedImage ? undefined : `sandcastle:${faker.word.noun()}`;
    const logger = mock<Logger>();
    const images = mock<SandboxImages>();
    const openRuntime = runRuntimeFactory({
      logLevel: 'silent',
      consoleLog: () => logger,
      images: () => images,
      runSettings: (config) => ({ ...runSettingsFrom(config), retryDelayMs: 0 }),
      openSession: async (_context, { run, events }) => {
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
      },
    });
    const request: RuntimeRequest = {
      repoRoot: repo.dir,
      logFormat: 'json',
      environment: unwrap(
        parseEnvironment(
          options.environment ?? { ANTHROPIC_API_KEY: faker.string.alphanumeric(20) },
          faker.system.directoryPath(),
        ),
      ),
      configSource: configFileSource(configDestination(repo.dir)),
      config: aJigConfig({ ...everyStepOn(), sandboxImage, ...options.config }),
      presetSource: new InMemoryPresetSource(),
    };
    const capabilities = () => openRuntime(request).run;
    const aRequest = () => `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`;
    return {
      capabilities,
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
