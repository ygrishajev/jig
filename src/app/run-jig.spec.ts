import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { panic, Result } from 'better-result';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it, vi } from 'vitest';

import { scriptWholeRun } from '../../tests/support/agent-scripts.js';
import { aRunState, everyStepOn, runId } from '../../tests/support/builders.js';
import { FakeAgentSession } from '../../tests/support/fakes.js';
import { openRunWorktree, sandboxCloneOf } from '../../tests/support/open-run-worktree.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { lockRun } from '../adapters/local-store/run-lock.js';
import { stateDirectory } from '../adapters/local-store/run-paths.js';
import type { OpenSessionInput } from '../adapters/sandcastle/open-session.js';
import type { SessionOpenFailure } from '../adapters/sandcastle/sandcastle-session.js';
import { parseEnvironment } from '../config/environment.js';
import { configFileFor, loadConfig } from '../config/load-config.js';
import {
  ConfigInvalid,
  LocalStateUnwritable,
  RunInProgress,
  RunRequestInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
} from '../domain/errors.js';
import { type RunId, runIdSchema } from '../domain/run-id.js';
import { runBranchFor } from '../domain/run-state.js';
import { createAppContainer } from './container.js';
import { runJig } from './run-jig.js';

/** TEST-NET-1: routable nowhere, so an exporter aimed at it waits out its timeout. */
const UNREACHABLE_COLLECTOR = 'http://192.0.2.1:4318';

describe('runJig', () => {
  it('starts a run from a request file and stops once the work waits to be merged', async () => {
    const { app, writeRequest, agentFor, repo } = await setup();
    const id = runId();
    const agent = agentFor(id);
    scriptWholeRun(agent);

    const report = (await runJig(app, { start: await writeRequest(), runId: id })).unwrap();

    expect(report).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
    expect(agent.closed).toBe(true);
    expect(await readResult(repo.dir, id)).toMatchObject({ status: 'halted', complete: false });
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

    const refusal = await runJig(app, { resume: id });

    expect(await readFile(tracked, 'utf-8')).toBe(original);
    expect(refusal.isErr() && refusal.error).toBeInstanceOf(LocalStateUnwritable);
  });

  it("ignores telemetry settings in the process environment that the app wasn't given", async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', UNREACHABLE_COLLECTOR);
    const { app, writeRequest, agentFor } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));

    const report = (await runJig(app, { start: await writeRequest(), runId: id })).unwrap();

    expect(report).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
  });

  it('resumes by id and finishes once a person has merged the run branch', async () => {
    const { app, writeRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    (await runJig(app, { start: await writeRequest(), runId: id })).unwrap();
    await simpleGit({ baseDir: repo.dir }).merge([runBranchFor(id), '--no-edit']);

    const report = (await runJig(app, { resume: id })).unwrap();

    expect(report.status).toBe('done');
    expect(await readResult(repo.dir, id)).toMatchObject({ status: 'done', complete: true });
  });

  it('resumes instead of starting over when given the same request and id again', async () => {
    const { app, writeRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const requestPath = await writeRequest();
    const first = (await runJig(app, { start: requestPath, runId: id })).unwrap();
    const commitsAfterFirst = await runBranchCommits(repo.dir, id);

    const second = (await runJig(app, { start: requestPath, runId: id })).unwrap();

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
    const { app, writeRequest, agentFor, holdNextSession } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const requestPath = await writeRequest();
    const held = holdNextSession();
    const first = runJig(app, { start: requestPath, runId: id });
    await held.opened;

    const refused = await runJig(app, { start: requestPath, runId: id });

    expect(refused.isErr() && refused.error).toBeInstanceOf(RunInProgress);

    held.release();
    await first;
    expect((await runJig(app, { resume: id })).unwrap()).toMatchObject({
      state: { phase: 'awaitingMerge' },
    });
  });

  it('starts the sandbox again when it failed for a reason that may pass', async () => {
    const { app, writeRequest, agentFor, failNextSessions } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const opened = failNextSessions(
      new SandboxUnavailable({ message: faker.lorem.sentence() }),
      new SetupCommandFailed({
        message: faker.lorem.sentence(),
        output: faker.lorem.sentence(),
      }),
    );

    const report = (await runJig(app, { start: await writeRequest(), runId: id })).unwrap();

    expect(report.state.phase).toBe('awaitingMerge');
    expect(opened()).toBe(3);
  });

  it('stops at once when the sandbox cannot start because of its configuration', async () => {
    const { app, writeRequest, agentFor, failNextSessions } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    const opened = failNextSessions(new ConfigInvalid({ message: faker.lorem.sentence() }));

    const result = await runJig(app, { start: await writeRequest(), runId: id });

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(opened()).toBe(1);
  });

  it('refuses to attach a different request to an existing run', async () => {
    const { app, writeRequest, agentFor } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));
    (await runJig(app, { start: await writeRequest(), runId: id })).unwrap();

    const result = await runJig(app, { start: await writeRequest(), runId: id });

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
  });

  it('refuses to resume a run that does not exist', async () => {
    const { app } = await setup();

    const result = await runJig(app, { resume: runId() });

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
  });

  it('releases the run lock when the run fails', async () => {
    const { app, repo } = await setup();
    const id = runId();

    const failed = await runJig(app, { resume: id });

    expect(failed.isErr() && failed.error).toBeInstanceOf(RunRequestInvalid);
    const lock = await lockRun(repo.dir, id);
    expect(lock.isOk()).toBe(true);
  });

  it('names a run started without an id after the heading of its request', async () => {
    const { app, repo, requests, failNextSessions } = await setup();
    failNextSessions(new ConfigInvalid({ message: faker.lorem.sentence() }));
    const file = path.join(requests, `${faker.string.uuid()}.md`);
    await writeFile(file, `# Add retry backoff\n\n${faker.lorem.paragraph()}`);

    await runJig(app, { start: file });

    expect(await readdir(path.join(repo.dir, '.jig'))).toContainEqual(
      expect.stringMatching(/^add-retry-backoff-[0-9a-f]{8}$/),
    );
  });

  it('refuses a request file that cannot be read', async () => {
    const { app, requests } = await setup();

    const result = await runJig(app, { start: path.join(requests, faker.word.noun()) });

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
  });

  it.each(['done', 'stuck'] as const)(
    'returns a %s run as it is, without building an image or starting a sandbox',
    async (phase) => {
      const { app, repo, sessionsOpened } = await setup({ managedImage: true });
      const state = aRunState({ phase });
      await new LocalRunStore(repo.dir).save(state);

      const report = (await runJig(app, { resume: state.runId })).unwrap();

      expect(report).toMatchObject({ status: phase, state: { phase } });
      expect(sessionsOpened()).toBe(0);
    },
  );

  async function setup(options: { managedImage?: boolean; environment?: NodeJS.ProcessEnv } = {}) {
    const repo = await createTempRepo();
    const requests = await tempDirectory('jig-request-');

    const app = createAppContainer({
      repoRoot: repo.dir,
      configFile: configFileFor(repo.dir),
      logFormat: 'json',
      logLevel: 'silent',
      environment: unwrap(
        parseEnvironment(
          options.environment ?? { ANTHROPIC_API_KEY: faker.string.alphanumeric(20) },
        ),
      ),
      config: unwrap(loadConfig(configFileFor(repo.dir))),
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
      config: asValue({
        ...unwrap(loadConfig(configFileFor(repo.dir))),
        ...everyStepOn(),
        sandboxImage,
      }),
    });
    app.register({
      settings: asValue({ ...app.cradle.settings, retryDelayMs: 0 }),
      openSession: asValue(async ({ run }: OpenSessionInput) => {
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
        return Result.ok(agent);
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
      requests,
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
