import { faker } from '@faker-js/faker';
import { Panic } from 'better-result';
import { describe, expect, it } from 'vitest';

import {
  aDescription,
  approval,
  rejection,
  scriptPlanning,
} from '../../tests/support/agent-scripts.js';
import {
  aCommit,
  aPlannedSlice,
  aRunStateIn,
  aSlice,
  runId,
  runSettings,
} from '../../tests/support/builders.js';
import {
  FakeAgentSession,
  InMemoryRunStore,
  RecordingEventSink,
  SteppingClock,
} from '../../tests/support/fakes.js';
import { createRunWorktree } from '../../tests/support/run-worktree.js';
import { SandboxUnavailable } from '../domain/errors.js';
import { type RunState, startRun } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { ExecResult } from '../ports/agent-session.js';
import { runEngine } from './engine.js';
import { runFlow } from './run-flow.js';

describe('runFlow', () => {
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
    agent.script('reviewer', approval(), approval());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.slices.map((slice) => slice.status)).toEqual(['approved', 'approved']);
    const merged = await git.log(['main', '-3']);
    expect(merged.all.map((commit) => commit.message)).toEqual(
      expect.arrayContaining(slices.map((slice) => slice.title)),
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
    agent.script('reviewer', { output: { approved: false, feedback } }, approval());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('halted');
    expect(state.phase).toBe('awaitingMerge');
    expect(state.slices[0]).toMatchObject({ status: 'approved', reviewCycles: 1 });
    expect(agent.calls.filter((call) => call.role === 'implementer')[1].prompt).toContain(feedback);
  });

  it('asks the reviewer again after a malformed verdict instead of sending the slice back to the implementer', async () => {
    const slice = aPlannedSlice();
    const { agent, run, start } = await setup({ settings: runSettings({ maxStepRetries: 1 }) });
    scriptPlanning(agent, [slice]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'b.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', malformedVerdict(), approval());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.slices[0]).toMatchObject({ status: 'approved', reviewCycles: 0 });
    expect(state.slices[0].lastFeedback).toBeUndefined();
    expect(agent.calls.filter((call) => call.role === 'implementer')).toHaveLength(1);
  });

  it('blocks a run whose reviewer keeps producing malformed verdicts, without spending review cycles', async () => {
    const maxStepRetries = faker.number.int({ min: 0, max: 2 });
    const { agent, run, start } = await setup({ settings: runSettings({ maxStepRetries }) });
    scriptPlanning(agent, [aPlannedSlice()]);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script(
      'reviewer',
      ...Array.from({ length: maxStepRetries + 1 }, () => malformedVerdict()),
    );

    const { status, state } = await run(start);

    expect(status).toBe('blocked');
    expect(state.slices[0]).toMatchObject({ status: 'in_review', reviewCycles: 0 });
    expect(agent.calls.filter((call) => call.role === 'implementer')).toHaveLength(1);
  });

  it('retries an implementation that changed nothing without spending a review cycle', async () => {
    const { agent, run, start } = await setup({ settings: runSettings({ reviewCycleCap: 1 }) });
    scriptPlanning(agent, [aPlannedSlice()]);
    agent.script('implementer', { files: {} }, { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approval());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.slices[0]).toMatchObject({
      status: 'approved',
      reviewCycles: 0,
      emptyAttempts: 1,
    });
  });

  it('never sends an implementation that changed nothing to review, and gives up after two such attempts', async () => {
    const { agent, run, start } = await setup({ settings: runSettings({ reviewCycleCap: 1 }) });
    scriptPlanning(agent, [aPlannedSlice()]);
    agent.script('implementer', { files: {} }, { files: {} });
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('stuck');
    expect(state.slices[0]).toMatchObject({ status: 'stuck', reviewCycles: 0, emptyAttempts: 2 });
    expect(agent.calls.filter((call) => call.role === 'reviewer')).toHaveLength(0);
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
    agent.script('reviewer', approval());
    agent.script('describer', aDescription());
    const resumed = await run(paused.state);
    expect(resumed.status).toBe('done');
  });

  it('finishes from saved state after an interruption with the commits an uninterrupted run makes', async () => {
    const slices = [aPlannedSlice(), aPlannedSlice()];
    const files = slices.map((slice) => ({ [`${slice.id}.txt`]: faker.lorem.paragraph() }));
    const settings = runSettings({ mergeMode: 'manual' });
    const uninterrupted = await setup({ settings });
    scriptPlanning(uninterrupted.agent, slices);
    uninterrupted.agent.script('implementer', ...files.map((written) => ({ files: written })));
    uninterrupted.agent.script('reviewer', approval(), approval());
    uninterrupted.agent.script('describer', aDescription());
    await uninterrupted.run(uninterrupted.start);
    const interrupted = await setup({ settings });
    const crash = new Error(faker.lorem.sentence());
    scriptPlanning(interrupted.agent, slices);
    interrupted.agent.script('implementer', ...files.map((written) => ({ files: written })));
    interrupted.agent.script('reviewer', approval(), { crash });

    await expect(interrupted.run(interrupted.start)).rejects.toThrow(Panic);
    const saved = (await interrupted.store.load(interrupted.start.runId)).unwrap();
    expect(saved?.slices.map((slice) => slice.status)).toEqual(['approved', 'in_review']);
    interrupted.agent.script('reviewer', approval());
    interrupted.agent.script('describer', aDescription());
    const finished = await interrupted.run(saved ?? interrupted.start);

    expect(finished).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
    const history = await uninterrupted.runBranchHistory();
    expect(history).toContain(slices[1].id);
    expect(await interrupted.runBranchHistory()).toBe(history);
  });

  it('verifies a slice before the reviewer sees it, and approves it with the record of what passed', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const reviewerCallsWhenCommandRan: number[] = [];
    const { agent, run, start } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => {
        reviewerCallsWhenCommandRan.push(
          agent.calls.filter((call) => call.role === 'reviewer').length,
        );
        return { exitCode: 0, output: faker.lorem.sentence() };
      },
    });
    scriptPlanning(agent, [aPlannedSlice()]);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approval());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(agent.commands).toEqual([verifyCommand]);
    expect(reviewerCallsWhenCommandRan).toEqual([0]);
    expect(agent.calls.filter((call) => call.role === 'reviewer')).toHaveLength(1);
    expect(state.slices[0]).toMatchObject({
      status: 'approved',
      verification: { command: verifyCommand },
    });
  });

  it('sends a slice back to the implementer when its verify fails, without a review that cycle', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const failure = faker.lorem.sentence();
    const results: ExecResult[] = [
      { exitCode: 1, output: failure },
      { exitCode: 0, output: faker.lorem.sentence() },
    ];
    const reviewerCallsWhenCommandRan: number[] = [];
    const { agent, run, start } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => {
        reviewerCallsWhenCommandRan.push(
          agent.calls.filter((call) => call.role === 'reviewer').length,
        );
        return results.shift() ?? { exitCode: 0, output: '' };
      },
    });
    scriptPlanning(agent, [aPlannedSlice()]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'b.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', approval());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.slices[0]).toMatchObject({
      status: 'approved',
      reviewCycles: 1,
      verification: { command: verifyCommand },
    });
    expect(agent.commands).toEqual([verifyCommand, verifyCommand]);
    expect(reviewerCallsWhenCommandRan).toEqual([0, 0]);
    expect(agent.calls.filter((call) => call.role === 'reviewer')).toHaveLength(1);
    expect(agent.calls.filter((call) => call.role === 'implementer')[1].prompt).toContain(failure);
  });

  it('leaves a slice stuck when its verify fails with the review cycle cap reached', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, start } = await setup({
      settings: runSettings({ reviewCycleCap: 1, verifyCommand }),
      exec: () => ({ exitCode: 1, output: faker.lorem.sentence() }),
    });
    scriptPlanning(agent, [aPlannedSlice()]);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('stuck');
    expect(state.slices[0]).toMatchObject({ status: 'stuck', reviewCycles: 1 });
    expect(agent.calls.filter((call) => call.role === 'reviewer')).toHaveLength(0);
    expect(agent.commands).toEqual([verifyCommand]);
  });

  it('verifies a resumed slice the reviewer approved before it counts as approved', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const reviewerCallsWhenCommandRan: number[] = [];
    const { agent, run } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => {
        reviewerCallsWhenCommandRan.push(
          agent.calls.filter((call) => call.role === 'reviewer').length,
        );
        return { exitCode: 0, output: faker.lorem.sentence() };
      },
    });
    const slice = aSlice({ status: 'in_review', commit: aCommit().sha });
    agent.script('reviewer', approval(), approval());
    agent.script('describer', aDescription());

    const { status, state } = await run(aRunStateIn('slices', { slices: [slice] }));

    expect(status).toBe('done');
    expect(agent.commands).toEqual([verifyCommand]);
    expect(reviewerCallsWhenCommandRan).toEqual([1]);
    expect(agent.calls.filter((call) => call.role === 'reviewer')).toHaveLength(2);
    expect(state.slices[0]).toMatchObject({
      status: 'approved',
      verification: { command: verifyCommand },
    });
  });

  it('describes a run whose slice ran out of review cycles, then ends it stuck', async () => {
    const { agent, run, start } = await setup({ settings: runSettings({ reviewCycleCap: 2 }) });
    scriptPlanning(agent, [aPlannedSlice()]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'b.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', rejection(), rejection());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('stuck');
    expect(state.slices[0]).toMatchObject({ status: 'stuck', reviewCycles: 2 });
    expect(state.prDescription).toContain(state.slices[0].lastFeedback);
  });

  async function setup(input: {
    settings: RunSettings;
    exec?: (command: string) => ExecResult | SandboxUnavailable;
  }) {
    const id = runId();
    const { sandboxPath, workspace, git, runBranch } = await createRunWorktree(id);
    const agent = new FakeAgentSession(sandboxPath, input.exec);
    const store = new InMemoryRunStore();
    const dependencies = {
      ports: { agent, workspace },
      store,
      events: new RecordingEventSink(),
      clock: new SteppingClock(),
      settings: input.settings,
    };
    const start = startRun({ runId: id, baseBranch: 'main', request: faker.lorem.paragraph() });
    const run = async (state: RunState) => (await runEngine(runFlow, state, dependencies)).unwrap();
    const runBranchHistory = () =>
      git.raw(['log', '--reverse', '--format=%s', '--patch', `main..${runBranch}`]);
    return { agent, run, start, store, git, runBranchHistory };
  }
});

function malformedVerdict() {
  return { output: { verdict: faker.lorem.word() } };
}
