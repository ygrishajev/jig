import { faker } from '@faker-js/faker';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorkspace } from '../adapters/git/git-workspace.js';
import { startRun, type RunState } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import {
  aContext,
  aFeaturePlan,
  aPlannedSlice,
  designDocs,
  runId,
  runSettings,
} from '../../tests/support/builders.js';
import {
  FakeAgentSession,
  InMemoryRunStore,
  RecordingEventSink,
  SteppingClock,
} from '../../tests/support/fakes.js';
import { createRunWorktree, type RunWorktree } from '../../tests/support/run-worktree.js';
import { runEngine } from './engine.js';
import { runFlow } from './run-flow.js';

describe('runFlow', () => {
  let worktree: RunWorktree | undefined;

  afterEach(async () => {
    await worktree?.cleanup();
    worktree = undefined;
  });

  it('takes a request from planning through two slices to a merged run branch', async () => {
    const slices = [aPlannedSlice(), aPlannedSlice()];
    const { agent, run, start, git } = await setup({
      settings: runSettings({ mergeMode: 'auto' }),
    });
    scriptPlanning(agent, slices);
    agent.script(
      'implementer',
      { files: { [`${slices[0].id}.txt`]: faker.lorem.sentence() } },
      { files: { [`${slices[1].id}.txt`]: faker.lorem.sentence() } },
    );
    agent.script('reviewer', approve(), approve());
    agent.script('describer', { output: { body: faker.lorem.paragraph() } });

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.slices.map((slice) => slice.status)).toEqual(['approved', 'approved']);
    const merged = await git.log(['main', '-3']);
    expect(merged.all.map((commit) => commit.message)).toEqual(
      expect.arrayContaining(slices.map((slice) => expect.stringContaining(slice.id))),
    );
  });

  it('sends a slice back with the reviewer feedback and gets it approved on the next attempt', async () => {
    const slice = aPlannedSlice();
    const feedback = faker.lorem.sentence();
    const { agent, run, start } = await setup({ settings: runSettings({ mergeMode: 'manual' }) });
    scriptPlanning(agent, [slice]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'b.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', { output: { approved: false, feedback } }, approve());
    agent.script('describer', { output: { body: faker.lorem.paragraph() } });

    const { status, state } = await run(start);

    expect(status).toBe('halted');
    expect(state.phase).toBe('awaitingMerge');
    expect(state.slices[0]).toMatchObject({ status: 'approved', reviewCycles: 1 });
    expect(agent.calls.filter((call) => call.role === 'implementer')[1].prompt).toContain(feedback);
  });

  it('stops for a person after planning when the design gate is a checkpoint, then continues on resume', async () => {
    const slice = aPlannedSlice();
    const { agent, run, start } = await setup({
      settings: runSettings({ designGate: 'checkpoint' }),
    });
    scriptPlanning(agent, [slice]);

    const paused = await run(start);
    expect(paused).toMatchObject({ status: 'halted', state: { phase: 'paused' } });
    expect(agent.calls.some((call) => call.role === 'implementer')).toBe(false);

    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approve());
    agent.script('describer', { output: { body: faker.lorem.paragraph() } });
    const resumed = await run(paused.state);
    expect(resumed.status).toBe('done');
  });

  it('finishes from saved state after an interruption without redoing finished work', async () => {
    const slices = [aPlannedSlice(), aPlannedSlice()];
    const { agent, run, start, store } = await setup({
      settings: runSettings({ mergeMode: 'auto' }),
    });
    scriptPlanning(agent, slices);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approve());

    await expect(run(start)).rejects.toThrow('no turn scripted for implementer');
    const saved = (await store.load(start.runId)) as RunState;
    expect(saved.slices.map((slice) => slice.status)).toEqual(['approved', 'pending']);

    agent.script('implementer', { files: { 'b.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approve());
    agent.script('describer', { output: { body: faker.lorem.paragraph() } });
    const finished = await run(saved);

    expect(finished.status).toBe('done');
    const implementerPrompts = agent.calls
      .filter((call) => call.role === 'implementer')
      .map((call) => call.prompt);
    expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(4);
    expect(implementerPrompts.filter((prompt) => prompt.includes(slices[0].title))).toHaveLength(1);
  });

  it('ends stuck once a slice runs out of review cycles', async () => {
    const { agent, run, start } = await setup({ settings: runSettings({ reviewCycleCap: 2 }) });
    scriptPlanning(agent, [aPlannedSlice()]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'b.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', reject(), reject());

    const { status, state } = await run(start);

    expect(status).toBe('stuck');
    expect(state.slices[0]).toMatchObject({ status: 'stuck', reviewCycles: 2 });
  });

  async function setup(input: { settings: RunSettings }) {
    const id = runId();
    const created = await createRunWorktree(id);
    worktree = created;
    const agent = new FakeAgentSession(created.worktreePath);
    const store = new InMemoryRunStore();
    const workspace = new GitWorkspace({
      repoRoot: created.repo.dir,
      worktreePath: created.worktreePath,
      runId: id,
      baseBranch: 'main',
    });
    const dependencies = {
      ports: { agent, workspace },
      store,
      events: new RecordingEventSink(),
      clock: new SteppingClock(),
      settings: input.settings,
    };
    const start = startRun({ runId: id, baseBranch: 'main', request: faker.lorem.paragraph() });
    const run = (state: RunState) => runEngine(runFlow, state, dependencies);
    return { agent, run, start, store, git: created.git };
  }
});

function scriptPlanning(agent: FakeAgentSession, slices: ReturnType<typeof aPlannedSlice>[]) {
  agent.script(
    'planner',
    { output: aContext() },
    { output: aFeaturePlan() },
    { output: designDocs() },
    { output: slices },
  );
}

function approve() {
  return { output: { approved: true, feedback: '' } };
}

function reject() {
  return { output: { approved: false, feedback: faker.lorem.sentence() } };
}
