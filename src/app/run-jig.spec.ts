import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it, vi } from 'vitest';

import { scriptWholeRun } from '../../tests/support/agent-scripts.js';
import { aRunState, runId } from '../../tests/support/builders.js';
import { FakeAgentSession } from '../../tests/support/fakes.js';
import { openRunWorktree } from '../../tests/support/open-run-worktree.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { stateDirectory } from '../adapters/local-store/run-paths.js';
import { parseEnvironment } from '../config/environment.js';
import { loadConfig } from '../config/load-config.js';
import {
  ConfigInvalid,
  RunInProgress,
  RunRequestInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
} from '../domain/errors.js';
import type { RunId } from '../domain/run-id.js';
import { runBranchFor } from '../domain/run-state.js';
import { createAppContainer, type OpenSessionInput } from './container.js';
import { runJig } from './run-jig.js';

/** TEST-NET-1: routable nowhere, so an exporter aimed at it waits out its timeout. */
const UNREACHABLE_COLLECTOR = 'http://192.0.2.1:4318';

describe('runJig', () => {
  it('starts a run from a request file and stops once the work waits to be merged', async () => {
    const { app, writeRequest, agentFor, repo } = await setup();
    const id = runId();
    const agent = agentFor(id);
    scriptWholeRun(agent);

    const report = await runJig(app, { start: await writeRequest(), runId: id });

    expect(report).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
    expect(agent.closed).toBe(true);
    expect(await readResult(repo.dir, id)).toMatchObject({ status: 'halted', complete: false });
  });

  it("ignores telemetry settings in the process environment that the app wasn't given", async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', UNREACHABLE_COLLECTOR);
    const { app, writeRequest, agentFor } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));

    const report = await runJig(app, { start: await writeRequest(), runId: id });

    expect(report).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
  });

  it('resumes by id and finishes once a person has merged the run branch', async () => {
    const { app, writeRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    await runJig(app, { start: await writeRequest(), runId: id });
    await simpleGit({ baseDir: repo.dir }).merge([runBranchFor(id), '--no-edit']);

    const report = await runJig(app, { resume: id });

    expect(report.status).toBe('done');
    expect(await readResult(repo.dir, id)).toMatchObject({ status: 'done', complete: true });
  });

  it('resumes instead of starting over when given the same request and id again', async () => {
    const { app, writeRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const requestPath = await writeRequest();
    const first = await runJig(app, { start: requestPath, runId: id });
    const commitsAfterFirst = await runBranchCommits(repo.dir, id);

    const second = await runJig(app, { start: requestPath, runId: id });

    expect(second).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
    expect(second.state.runId).toBe(id);
    expect(second.state.plan).toEqual(first.state.plan);
    expect(second.state.slices).toEqual(first.state.slices);
    const saved = await new LocalRunStore(repo.dir).load(id);
    expect(saved?.phase).toBe('awaitingMerge');
    expect(saved?.slices).toEqual(first.state.slices);
    expect(await runBranchCommits(repo.dir, id)).toEqual(commitsAfterFirst);
  });

  it('refuses a second run of the same id while the first is going, and runs it once that one stops', async () => {
    const { app, writeRequest, agentFor, holdNextSession } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const requestPath = await writeRequest();
    const held = holdNextSession();
    const first = runJig(app, { start: requestPath, runId: id });
    await held.opened;

    await expect(runJig(app, { start: requestPath, runId: id })).rejects.toBeInstanceOf(
      RunInProgress,
    );

    held.release();
    await first;
    expect(await runJig(app, { resume: id })).toMatchObject({ state: { phase: 'awaitingMerge' } });
  });

  it('starts the sandbox again when it failed for a reason that may pass', async () => {
    const { app, writeRequest, agentFor, failNextSessions } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const opened = failNextSessions(
      new SandboxUnavailable(faker.lorem.sentence()),
      new SetupCommandFailed(faker.lorem.sentence(), faker.lorem.sentence()),
    );

    const report = await runJig(app, { start: await writeRequest(), runId: id });

    expect(report.state.phase).toBe('awaitingMerge');
    expect(opened()).toBe(3);
  });

  it('stops at once when the sandbox cannot start because of its configuration', async () => {
    const { app, writeRequest, agentFor, failNextSessions } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const opened = failNextSessions(new ConfigInvalid(faker.lorem.sentence()));

    await expect(runJig(app, { start: await writeRequest(), runId: id })).rejects.toBeInstanceOf(
      ConfigInvalid,
    );
    expect(opened()).toBe(1);
  });

  it('refuses to attach a different request to an existing run', async () => {
    const { app, writeRequest, agentFor } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    await runJig(app, { start: await writeRequest(), runId: id });

    await expect(runJig(app, { start: await writeRequest(), runId: id })).rejects.toBeInstanceOf(
      RunRequestInvalid,
    );
  });

  it('refuses to resume a run that does not exist', async () => {
    const { app } = await setup();

    await expect(runJig(app, { resume: runId() })).rejects.toBeInstanceOf(RunRequestInvalid);
  });

  it.each(['done', 'stuck'] as const)(
    'returns a %s run as it is, without building an image or starting a sandbox',
    async (phase) => {
      const { app, repo, sessionsOpened } = await setup({ managedImage: true });
      const state = aRunState({ phase });
      await new LocalRunStore(repo.dir).save(state);

      const report = await runJig(app, { resume: state.runId });

      expect(report).toMatchObject({ status: phase, state: { phase } });
      expect(sessionsOpened()).toBe(0);
    },
  );

  async function setup(options: { managedImage?: boolean } = {}) {
    const repo = await createTempRepo();
    const requests = await tempDirectory('jig-request-');

    const app = createAppContainer({
      repoRoot: repo.dir,
      logFormat: 'json',
      logLevel: 'silent',
      environment: parseEnvironment({}),
    });
    const agents = new Map<string, FakeAgentSession>();
    const agentFor = (id: string) => {
      const agent = new FakeAgentSession(path.join(repo.dir, '.jig', id, 'workspace'));
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
    let sessionFailures: Error[] = [];
    let sessionsOpened = 0;
    const failNextSessions = (...failures: Error[]) => {
      sessionFailures = failures;
      return () => sessionsOpened;
    };
    const sandboxImage = options.managedImage ? undefined : `sandcastle:${faker.word.noun()}`;
    app.register({ config: asValue({ ...loadConfig(repo.dir), sandboxImage }) });
    app.register({
      settings: asValue({ ...app.cradle.settings, retryDelayMs: 0 }),
      openSession: asValue(async ({ run }: OpenSessionInput) => {
        sessionsOpened++;
        const failure = sessionFailures.shift();
        if (failure) throw failure;
        const agent = agents.get(run.runId);
        if (!agent) throw new Error(`No fake agent prepared for run ${run.runId}`);
        const holding = held;
        held = undefined;
        holding?.opened();
        await holding?.released;
        await openRunWorktree({ repoRoot: repo.dir, ...run });
        return agent;
      }),
    });
    const writeRequest = async () => {
      const file = path.join(requests, `${faker.string.uuid()}.md`);
      await writeFile(file, `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`);
      return file;
    };
    return {
      app,
      repo,
      writeRequest,
      agentFor,
      holdNextSession,
      failNextSessions,
      sessionsOpened: () => sessionsOpened,
    };
  }
});

async function runBranchCommits(repoRoot: string, id: RunId) {
  const log = await simpleGit({ baseDir: repoRoot }).log([`main..${runBranchFor(id)}`]);
  return log.all.map((commit) => commit.hash);
}

async function readResult(repoRoot: string, id: RunId) {
  return JSON.parse(
    await readFile(path.join(stateDirectory(repoRoot, id), 'result.json'), 'utf-8'),
  );
}
