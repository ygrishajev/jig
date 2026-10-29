import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import { stateDirectory } from '../adapters/local-store/run-paths.js';
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
import {
  aContext,
  aFeaturePlan,
  aPlannedSlice,
  designDocs,
  runId,
} from '../../tests/support/builders.js';
import { FakeAgentSession } from '../../tests/support/fakes.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { openRunWorktree } from '../../tests/support/open-run-worktree.js';
import { createAppContainer, type OpenSessionInput } from './container.js';
import { runSdlc } from './run-sdlc.js';

describe('runSdlc', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('starts a run from a request file and stops once the work waits to be merged', async () => {
    const { app, writeRequest, agentFor, repo } = await setup();
    const id = runId();
    const agent = agentFor(id);
    scriptWholeRun(agent);

    const report = await runSdlc(app, { requestPath: await writeRequest(), runId: id });

    expect(report).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
    expect(agent.closed).toBe(true);
    expect(await readResult(repo.dir, id)).toMatchObject({ status: 'halted', complete: false });
  });

  it('resumes by id and finishes once a person has merged the run branch', async () => {
    const { app, writeRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    await runSdlc(app, { requestPath: await writeRequest(), runId: id });
    await simpleGit({ baseDir: repo.dir }).merge([runBranchFor(id), '--no-edit']);

    const report = await runSdlc(app, { runId: id });

    expect(report.status).toBe('done');
    expect(await readResult(repo.dir, id)).toMatchObject({ status: 'done', complete: true });
  });

  it('resumes instead of starting over when given the same request and id again', async () => {
    const { app, writeRequest, agentFor } = await setup();
    const id = runId();
    const agent = agentFor(id);
    scriptWholeRun(agent);
    const requestPath = await writeRequest();
    await runSdlc(app, { requestPath, runId: id });

    await runSdlc(app, { requestPath, runId: id });

    expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(4);
  });

  it('refuses a second run of the same id while the first is going, and runs it once that one stops', async () => {
    const { app, writeRequest, agentFor, holdNextSession } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const requestPath = await writeRequest();
    const held = holdNextSession();
    const first = runSdlc(app, { requestPath, runId: id });
    await held.opened;

    await expect(runSdlc(app, { requestPath, runId: id })).rejects.toBeInstanceOf(RunInProgress);

    held.release();
    await first;
    expect(await runSdlc(app, { runId: id })).toMatchObject({ state: { phase: 'awaitingMerge' } });
  });

  it('starts the sandbox again when it failed for a reason that may pass', async () => {
    const { app, writeRequest, agentFor, failNextSessions } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const opened = failNextSessions(
      new SandboxUnavailable(faker.lorem.sentence()),
      new SetupCommandFailed(faker.lorem.sentence(), faker.lorem.sentence()),
    );

    const report = await runSdlc(app, { requestPath: await writeRequest(), runId: id });

    expect(report.state.phase).toBe('awaitingMerge');
    expect(opened()).toBe(3);
  });

  it('stops at once when the sandbox cannot start because of its configuration', async () => {
    const { app, writeRequest, agentFor, failNextSessions } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const opened = failNextSessions(new ConfigInvalid(faker.lorem.sentence()));

    await expect(
      runSdlc(app, { requestPath: await writeRequest(), runId: id }),
    ).rejects.toBeInstanceOf(ConfigInvalid);
    expect(opened()).toBe(1);
  });

  it('refuses to attach a different request to an existing run', async () => {
    const { app, writeRequest, agentFor } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    await runSdlc(app, { requestPath: await writeRequest(), runId: id });

    await expect(runSdlc(app, { requestPath: await writeRequest(), runId: id })).rejects.toThrow(
      'started from a different request',
    );
  });

  it('refuses to resume a run that does not exist, or to run with nothing to go on', async () => {
    const { app } = await setup();

    await expect(runSdlc(app, { runId: runId() })).rejects.toThrow('No run found');
    await expect(runSdlc(app, {})).rejects.toBeInstanceOf(RunRequestInvalid);
  });

  async function setup() {
    const repo = await createTempRepo();
    const requests = await mkdtemp(path.join(tmpdir(), 'sdlc-request-'));
    cleanups.push(repo.cleanup, () => rm(requests, { recursive: true, force: true }));

    const app = createAppContainer({ repoRoot: repo.dir, logFormat: 'json', logLevel: 'silent' });
    const agents = new Map<string, FakeAgentSession>();
    const agentFor = (id: string) => {
      const agent = new FakeAgentSession(path.join(repo.dir, '.sdlc', id, 'workspace'));
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
    app.register({
      config: asValue({ ...loadConfig(repo.dir), sandboxImage: `sandcastle:${faker.word.noun()}` }),
    });
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
        await openRunWorktree({ repoRoot: repo.dir, ...run, skipCommitSigning: false });
        return agent;
      }),
    });
    const writeRequest = async () => {
      const file = path.join(requests, `${faker.string.uuid()}.md`);
      await writeFile(file, `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`);
      return file;
    };
    return { app, repo, writeRequest, agentFor, holdNextSession, failNextSessions };
  }
});

function scriptWholeRun(agent: FakeAgentSession) {
  agent.script(
    'planner',
    { output: aContext() },
    { output: aFeaturePlan() },
    { output: designDocs() },
    { output: [aPlannedSlice()] },
  );
  agent.script('implementer', { files: { [`${faker.word.noun()}.txt`]: faker.lorem.sentence() } });
  agent.script('reviewer', { output: { approved: true, feedback: '' } });
  agent.script('describer', { output: { body: faker.lorem.paragraph() } });
}

async function readResult(repoRoot: string, id: RunId) {
  return JSON.parse(
    await readFile(path.join(stateDirectory(repoRoot, id), 'result.json'), 'utf-8'),
  );
}
