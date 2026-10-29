import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import { stateDirectory } from '../adapters/local-store/run-paths.js';
import { RunRequestInvalid } from '../domain/errors.js';
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
import { createAppContainer, type AgentSessionOptions } from './container.js';
import { runSdlc } from './run-sdlc.js';

describe('runSdlc', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('starts a run from a request file and stops once the work waits to be merged', async () => {
    const { app, writeRequest, agentFor, repo } = await setup();
    const id = runId();
    scriptWholeRun(agentFor(id));

    const report = await runSdlc(app, { requestPath: await writeRequest(), runId: id });

    expect(report).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
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

  it('refuses a run id that cannot become a directory and branch name', async () => {
    const { app, writeRequest } = await setup();

    await expect(
      runSdlc(app, {
        requestPath: await writeRequest(),
        runId: `${faker.word.noun()} ${faker.word.noun()}`,
      }),
    ).rejects.toThrow('Invalid run id');
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
    app.register({
      createAgentSession: asValue(({ worktreePath }: AgentSessionOptions) => {
        const agent = [...agents.values()].find(
          (candidate) => candidate.worktreePath === worktreePath,
        );
        if (!agent) throw new Error(`No fake agent prepared for ${worktreePath}`);
        return agent;
      }),
    });
    const writeRequest = async () => {
      const file = path.join(requests, `${faker.string.uuid()}.md`);
      await writeFile(file, `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`);
      return file;
    };
    return { app, repo, writeRequest, agentFor };
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

async function readResult(repoRoot: string, id: string) {
  return JSON.parse(
    await readFile(path.join(stateDirectory(repoRoot, id), 'result.json'), 'utf-8'),
  );
}
