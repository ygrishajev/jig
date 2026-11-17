import { faker } from '@faker-js/faker';
import { Panic, panic } from 'better-result';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  aDescription,
  approval,
  fulfillment,
  rejection,
  ruleFindings,
  scriptPlanning,
} from '../../tests/support/agent-scripts.js';
import {
  aPlannedSlice,
  aRunState,
  aRunStateIn,
  aSlice,
  implementingPlanSteps,
  runSettings,
} from '../../tests/support/builders.js';
import {
  malformedVerdict,
  reviewsAfterDesign,
  scriptDelivery,
  setupRunFlow,
} from '../../tests/support/run-flow-setup.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { AgentRunFailed } from '../domain/errors.js';
import { finalStatus } from './define-flow.js';
import { runFlow } from './run-flow.js';

describe('runFlow delivery', () => {
  it('takes a request from planning through two slices to a merged run branch', async () => {
    const slices = [
      aPlannedSlice({ description: implementingPlanSteps(1) }),
      aPlannedSlice({ description: implementingPlanSteps(1) }),
    ];
    const { agent, run, start, git } = await setupRunFlow({
      settings: runSettings({ mergeMode: 'auto' }),
    });
    scriptPlanning(agent, slices);
    agent.script(
      'implementer',
      { files: { [`${slices[0].id}.txt`]: faker.lorem.sentence() } },
      { files: { [`${slices[1].id}.txt`]: faker.lorem.sentence() } },
    );
    agent.script('reviewer', approval(), approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.slices.map((slice) => slice.status)).toEqual(['approved', 'approved']);
    expect(state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 1 });
    const merged = await git.log(['main', '-3']);
    expect(merged.all.map((commit) => commit.message)).toEqual(
      expect.arrayContaining(slices.map((slice) => slice.title)),
    );
  });

  it('ends a run that skips the merge as completed, with its commits on the run branch only', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start, git, runBranch, workspace } = await setupRunFlow({
      settings: runSettings({ mergeMode: 'auto' }),
    });
    const merge = vi.spyOn(workspace, 'mergeRunBranch');
    scriptPlanning(agent, [slice]);
    scriptDelivery(agent, [slice]);

    const { status, state } = await run({ ...start, merge: false });

    expect(status).toBe('completed');
    expect(state.phase).toBe('completed');
    expect(merge).not.toHaveBeenCalled();
    const onRunBranch = await git.raw(['log', '--format=%s', `main..${runBranch}`]);
    expect(onRunBranch).toContain(slice.title);
    expect(await git.raw(['log', '--format=%s', 'main'])).not.toContain(slice.title);
  });

  it('ends a run that skips the merge as completed even when merges are manual', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start, events } = await setupRunFlow({
      settings: runSettings({ mergeMode: 'manual' }),
    });
    scriptPlanning(agent, [slice]);
    scriptDelivery(agent, [slice]);

    const { status } = await run({ ...start, merge: false });

    expect(status).toBe('completed');
    expect(events.ofType('phaseChanged').filter((change) => change.to === 'awaitingMerge')).toEqual(
      [],
    );
  });

  it('ends a run that skips the merge as stuck when a slice runs out of review cycles', async () => {
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ reviewCycleCap: 1 }),
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', rejection());
    agent.script('describer', aDescription());

    const { status } = await run({ ...start, merge: false });

    expect(status).toBe('stuck');
  });

  it('halts a run that skips the merge at the design checkpoint and completes it on resume', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ designGate: 'checkpoint' }),
    });
    scriptPlanning(agent, [slice]);

    const paused = await run({ ...start, merge: false });
    expect(paused).toMatchObject({ status: 'halted', state: { phase: 'paused' } });

    scriptDelivery(agent, [slice]);
    const resumed = await run(paused.state);
    expect(resumed.status).toBe('completed');
  });

  it('reads a run in the completed phase as finished as completed', () => {
    const completed = aRunState({ phase: 'completed' });

    expect(finalStatus(runFlow, completed)).toBe('completed');
  });

  it('sends a slice back with the reviewer feedback and gets it approved on the next attempt', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const feedback = faker.lorem.sentence();
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ mergeMode: 'manual' }),
    });
    scriptPlanning(agent, [slice]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'b.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', rejection(feedback), approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('halted');
    expect(state.phase).toBe('awaitingMerge');
    expect(state.slices[0]).toMatchObject({ status: 'approved', reviewCycles: 1 });
    expect(agent.calls.filter((call) => call.role === 'implementer')[1].prompt).toContain(feedback);
  });

  it('asks the reviewer again after a malformed verdict instead of sending the slice back to the implementer', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ maxStepRetries: 1 }),
    });
    scriptPlanning(agent, [slice]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'b.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', malformedVerdict(), approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.slices[0]).toMatchObject({ status: 'approved', reviewCycles: 0 });
    expect(state.slices[0].lastFeedback).toBeUndefined();
    expect(agent.calls.filter((call) => call.role === 'implementer')).toHaveLength(1);
  });

  it('blocks a run whose reviewer keeps producing malformed verdicts, without spending review cycles', async () => {
    const maxStepRetries = faker.number.int({ min: 0, max: 2 });
    const { agent, run, start } = await setupRunFlow({ settings: runSettings({ maxStepRetries }) });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
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
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ reviewCycleCap: 1 }),
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script('implementer', { files: {} }, { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approval(), fulfillment());
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
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ reviewCycleCap: 1 }),
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script('implementer', { files: {} }, { files: {} });
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('stuck');
    expect(state.slices[0]).toMatchObject({ status: 'stuck', reviewCycles: 0, emptyAttempts: 2 });
    expect(reviewsAfterDesign(agent)).toHaveLength(0);
  });

  it('sends rule fixes back without spending a review cycle, and gives up after two rounds of them', async () => {
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ reviewCycleCap: 1 }),
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script(
      'implementer',
      ...Array.from({ length: 2 }, () => ({ files: { 'a.txt': faker.lorem.sentence() } })),
    );
    agent.script('reviewer', ruleFindings(), ruleFindings());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('stuck');
    expect(state.slices[0]).toMatchObject({ status: 'stuck', reviewCycles: 0, ruleFixCycles: 2 });
  });

  it('approves a slice after a round of rule fixes even at the review cap', async () => {
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ reviewCycleCap: 1 }),
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'a.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', ruleFindings(), approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.slices[0]).toMatchObject({ reviewCycles: 0, ruleFixCycles: 1 });
  });

  it.each([
    ['hookFailures', 1],
    ['hookFailures', 2],
    ['verificationFailures', 1],
    ['verificationFailures', 2],
  ] as const)(
    'persists %s across resume and stops on the third failure from %i',
    async (counter, failures) => {
      const { agent, run, start, sandboxPath, rejectCommitsInSandbox } = await setupRunFlow({
        settings: runSettings({ reviewCycleCap: 1, maxStepRetries: 0, verifyCommand: 'npm test' }),
        exec: () => ({ exitCode: 1, output: faker.lorem.sentence() }),
      });
      const store = new LocalRunStore(sandboxPath);
      const slice = aSlice({
        status: 'pending',
        hookFailures: 1,
        verificationFailures: 1,
        [counter]: failures,
        reviewCycles: 0,
      });
      if (counter === 'hookFailures') await rejectCommitsInSandbox(faker.lorem.words(4));
      agent.script('implementer', { files: { 'feature.txt': faker.lorem.sentence() } });
      if (failures === 1) {
        agent.script('implementer', {
          fail: new AgentRunFailed({ message: faker.lorem.sentence() }),
        });
      }
      agent.script('describer', aDescription());

      const first = await run(aRunStateIn('slices', { runId: start.runId, slices: [slice] }));
      expect(first.state.slices[0]).toMatchObject({
        hookFailures: 1,
        verificationFailures: 1,
        [counter]: failures + 1,
        reviewCycles: 0,
        status: failures === 1 ? 'pending' : 'stuck',
      });
      expect(first.status).toBe(failures === 1 ? 'blocked' : 'stuck');
      (await store.save(first.state)).unwrap();
      const loaded = (await store.load(start.runId)).unwrap();
      expect(loaded).toEqual(first.state);
      if (!loaded) panic('The saved run is missing');
      agent.script('implementer', { files: { 'feature.txt': faker.lorem.sentence() } });

      const resumed = await run(loaded);
      expect(resumed.status).toBe('stuck');
      expect(resumed.state.slices[0]).toMatchObject({
        hookFailures: 1,
        verificationFailures: 1,
        [counter]: 3,
        reviewCycles: 0,
      });
      expect(resumed.state.slices[0].lastFeedback).toBeTruthy();
      for (const line of resumed.state.slices[0].lastFeedback?.split('\n') ?? []) {
        expect(resumed.state.prDescription).toContain(line);
      }
    },
  );

  it('keeps the three-review allowance after a hook rejection followed by two reviewer rejections', async () => {
    const { agent, run, start, sandboxPath, rejectCommitsInSandbox } = await setupRunFlow({
      settings: runSettings({ reviewCycleCap: 3, maxStepRetries: 0 }),
    });
    const output = faker.lorem.words(4);
    await rejectCommitsInSandbox(output);
    agent.script(
      'implementer',
      { files: { 'feature.txt': faker.lorem.sentence() } },
      { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) },
    );
    const slice = aSlice({ status: 'pending', reviewCycles: 0, hookFailures: 0 });
    const blocked = await run(aRunStateIn('slices', { runId: start.runId, slices: [slice] }));
    expect(blocked.state.slices[0]).toMatchObject({
      hookFailures: 1,
      reviewCycles: 0,
      status: 'pending',
    });
    expect(blocked.state.slices[0].lastFeedback).toContain(output);
    await rm(path.join(sandboxPath, '.git', 'hooks', 'commit-msg'));
    agent.script(
      'implementer',
      ...Array.from({ length: 3 }, () => ({ files: { 'feature.txt': faker.lorem.sentence() } })),
    );
    agent.script('reviewer', rejection(), rejection(), approval(), fulfillment());
    agent.script('describer', aDescription());

    const resumed = await run(blocked.state);

    expect(resumed.status).toBe('done');
    expect(resumed.state.slices[0]).toMatchObject({
      hookFailures: 1,
      reviewCycles: 2,
      status: 'approved',
    });
  });

  it('stops for a person after planning when the design gate is a checkpoint, then continues on resume', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ designGate: 'checkpoint' }),
    });
    scriptPlanning(agent, [slice]);

    const paused = await run(start);
    expect(paused).toMatchObject({ status: 'halted', state: { phase: 'paused' } });
    expect(agent.calls.some((call) => call.role === 'implementer')).toBe(false);

    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approval(), fulfillment());
    agent.script('describer', aDescription());
    const resumed = await run(paused.state);
    expect(resumed.status).toBe('done');
  });

  it('finishes from saved state after an interruption with the commits an uninterrupted run makes', async () => {
    const slices = [
      aPlannedSlice({ description: implementingPlanSteps(1) }),
      aPlannedSlice({ description: implementingPlanSteps(1) }),
    ];
    const files = slices.map((slice) => ({ [`${slice.id}.txt`]: faker.lorem.paragraph() }));
    const settings = runSettings({ mergeMode: 'manual' });
    const uninterrupted = await setupRunFlow({ settings });
    scriptPlanning(uninterrupted.agent, slices);
    uninterrupted.agent.script('implementer', ...files.map((written) => ({ files: written })));
    uninterrupted.agent.script('reviewer', approval(), approval(), fulfillment());
    uninterrupted.agent.script('describer', aDescription());
    await uninterrupted.run(uninterrupted.start);
    const interrupted = await setupRunFlow({ settings });
    const crash = new Error(faker.lorem.sentence());
    scriptPlanning(interrupted.agent, slices);
    interrupted.agent.script('implementer', ...files.map((written) => ({ files: written })));
    interrupted.agent.script('reviewer', approval(), { crash });

    await expect(interrupted.run(interrupted.start)).rejects.toThrow(Panic);
    const saved = (await interrupted.store.load(interrupted.start.runId)).unwrap();
    expect(saved?.slices.map((slice) => slice.status)).toEqual(['approved', 'in_review']);
    interrupted.agent.script('reviewer', approval(), fulfillment());
    interrupted.agent.script('describer', aDescription());
    const finished = await interrupted.run(saved ?? interrupted.start);

    expect(finished).toMatchObject({ status: 'halted', state: { phase: 'awaitingMerge' } });
    const history = await uninterrupted.runBranchHistory();
    expect(history).toContain(slices[1].id);
    expect(await interrupted.runBranchHistory()).toBe(history);
  });
});
