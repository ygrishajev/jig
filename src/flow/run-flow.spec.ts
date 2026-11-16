import { faker } from '@faker-js/faker';
import { Panic, panic, Result } from 'better-result';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  rejection,
  ruleFindings,
  scriptPlanning,
  unfulfilled,
} from '../../tests/support/agent-scripts.js';
import {
  aCommit,
  aContext,
  aDesignFinding,
  aDisposition,
  aFeaturePlan,
  aFirstDesignReview,
  anApprovedDesignReview,
  aPlannedSlice,
  aRevisedDesignReview,
  aRevisionAwaitingReReview,
  aRunState,
  aRunStateIn,
  aSlice,
  designDocs,
  implementingPlanSteps,
  planWithSteps,
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
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { AgentRunFailed, RunStateConflict, SandboxUnavailable } from '../domain/errors.js';
import { type RunState, startRun } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { PlannedSlice } from '../domain/slice.js';
import type { ExecResult } from '../ports/agent-session.js';
import type { RunStore } from '../ports/run-store.js';
import { runEngine } from './engine.js';
import { runFlow } from './run-flow.js';

describe('runFlow', () => {
  it('takes a request from planning through two slices to a merged run branch', async () => {
    const slices = [
      aPlannedSlice({ description: implementingPlanSteps(1) }),
      aPlannedSlice({ description: implementingPlanSteps(1) }),
    ];
    const { agent, run, start, git } = await setup({
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

  it('sends a slice back with the reviewer feedback and gets it approved on the next attempt', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const feedback = faker.lorem.sentence();
    const { agent, run, start } = await setup({ settings: runSettings({ mergeMode: 'manual' }) });
    scriptPlanning(agent, [slice]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'b.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', { output: { approved: false, feedback } }, approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('halted');
    expect(state.phase).toBe('awaitingMerge');
    expect(state.slices[0]).toMatchObject({ status: 'approved', reviewCycles: 1 });
    expect(agent.calls.filter((call) => call.role === 'implementer')[1].prompt).toContain(feedback);
  });

  it('asks the reviewer again after a malformed verdict instead of sending the slice back to the implementer', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({ settings: runSettings({ maxStepRetries: 1 }) });
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
    const { agent, run, start } = await setup({ settings: runSettings({ maxStepRetries }) });
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
    const { agent, run, start } = await setup({ settings: runSettings({ reviewCycleCap: 1 }) });
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
    const { agent, run, start } = await setup({ settings: runSettings({ reviewCycleCap: 1 }) });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script('implementer', { files: {} }, { files: {} });
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('stuck');
    expect(state.slices[0]).toMatchObject({ status: 'stuck', reviewCycles: 0, emptyAttempts: 2 });
    expect(reviewsAfterDesign(agent)).toHaveLength(0);
  });

  it('sends rule fixes back without spending a review cycle, and gives up after two rounds of them', async () => {
    const { agent, run, start } = await setup({ settings: runSettings({ reviewCycleCap: 1 }) });
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
    const { agent, run, start } = await setup({ settings: runSettings({ reviewCycleCap: 1 }) });
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
      const { agent, run, start, sandboxPath, rejectCommitsInSandbox } = await setup({
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
    },
  );

  it('keeps the three-review allowance after a hook rejection followed by two reviewer rejections', async () => {
    const { agent, run, start, sandboxPath, rejectCommitsInSandbox } = await setup({
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
    const { agent, run, start } = await setup({
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
    const uninterrupted = await setup({ settings });
    scriptPlanning(uninterrupted.agent, slices);
    uninterrupted.agent.script('implementer', ...files.map((written) => ({ files: written })));
    uninterrupted.agent.script('reviewer', approval(), approval(), fulfillment());
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
    interrupted.agent.script('reviewer', approval(), fulfillment());
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
        reviewerCallsWhenCommandRan.push(reviewsAfterDesign(agent).length);
        return { exitCode: 0, output: faker.lorem.sentence() };
      },
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(agent.commands).toEqual([verifyCommand, verifyCommand]);
    expect(reviewerCallsWhenCommandRan).toEqual([0, 1]);
    expect(reviewsAfterDesign(agent)).toHaveLength(2);
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
        reviewerCallsWhenCommandRan.push(reviewsAfterDesign(agent).length);
        return results.shift() ?? { exitCode: 0, output: '' };
      },
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'b.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.slices[0]).toMatchObject({
      status: 'approved',
      reviewCycles: 0,
      verificationFailures: 1,
      verification: { command: verifyCommand },
    });
    expect(agent.commands).toEqual([verifyCommand, verifyCommand, verifyCommand]);
    expect(reviewerCallsWhenCommandRan).toEqual([0, 0, 1]);
    expect(reviewsAfterDesign(agent)).toHaveLength(2);
    expect(agent.calls.filter((call) => call.role === 'implementer')[1].prompt).toContain(failure);
  });

  it('leaves a slice stuck after three verification failures independently of the review cap', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, start } = await setup({
      settings: runSettings({ reviewCycleCap: 1, verifyCommand }),
      exec: () => ({ exitCode: 1, output: faker.lorem.sentence() }),
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script(
      'implementer',
      ...Array.from({ length: 3 }, () => ({ files: { 'a.txt': faker.lorem.sentence() } })),
    );
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('stuck');
    expect(state.slices[0]).toMatchObject({
      status: 'stuck',
      reviewCycles: 0,
      verificationFailures: 3,
    });
    expect(reviewsAfterDesign(agent)).toHaveLength(0);
    expect(agent.commands).toEqual([verifyCommand, verifyCommand, verifyCommand]);
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
    agent.script('reviewer', approval(), approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(aRunStateIn('slices', { slices: [slice] }));

    expect(status).toBe('done');
    expect(agent.commands).toEqual([verifyCommand, verifyCommand]);
    expect(reviewerCallsWhenCommandRan).toEqual([1, 2]);
    expect(agent.calls.filter((call) => call.role === 'reviewer')).toHaveLength(3);
    expect(state.slices[0]).toMatchObject({
      status: 'approved',
      verification: { command: verifyCommand },
    });
  });

  it('skips the final check when a slice runs out of review cycles, and ends the run stuck and unmerged', async () => {
    const { agent, run, start, git } = await setup({
      settings: runSettings({ reviewCycleCap: 2 }),
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
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
    expect(state.finalCheck).toBeUndefined();
    expect(reviewsAfterDesign(agent)).toHaveLength(2);
    expect((await git.log(['main'])).all).toHaveLength(1);
  });

  it('runs the final check on the whole request once every slice is approved, then describes', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({ settings: runSettings() });
    scriptPlanning(agent, [slice]);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 1 });
    expect(agent.calls.at(-2)?.prompt).toContain(state.request);
  });

  it('gives a failed final check one repair and merges when the repair fulfils the request', async () => {
    const gap = faker.lorem.sentence();
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start, git, runBranch } = await setup({ settings: runSettings() });
    scriptPlanning(agent, [slice]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'fix.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', approval(), unfulfilled(gap), approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 2 });
    expect(state.slices[0]).toMatchObject({ id: slice.id, status: 'approved' });
    expect(state.slices[1]).toMatchObject({ id: 'final-fixes', status: 'approved' });
    const repair = state.slices[1];
    expect(repair.commit).toBeTruthy();
    expect(agent.calls.filter((call) => call.role === 'implementer')[1].prompt).toContain(gap);
    expect(reviewsAfterDesign(agent)[2].prompt).toContain(gap);
    expect((await git.log(['main'])).all.map((commit) => commit.message)).toContain(repair.title);
    expect(await git.revparse(['main'])).toBe(repair.commit);
    expect(await git.revparse([runBranch])).toBe(repair.commit);
  });

  it('refuses to merge when the run branch gained an unapproved commit after the last approval', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const crash = new Error(faker.lorem.sentence());
    const { agent, run, start, store, git, runBranch, worktreePath } = await setup({
      settings: runSettings(),
    });
    scriptPlanning(agent, [slice]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'fix.txt': faker.lorem.sentence() } },
    );
    agent.script(
      'reviewer',
      approval(),
      unfulfilled(faker.lorem.sentence()),
      approval(),
      fulfillment(),
    );
    agent.script('describer', { crash });

    await expect(run(start)).rejects.toThrow(Panic);
    const saved = (await store.load(start.runId)).unwrap();
    expect(saved?.finalCheck).toMatchObject({ fulfilled: true, round: 2 });
    expect(saved?.slices.at(-1)).toMatchObject({ id: 'final-fixes', status: 'approved' });
    expect(saved?.slices.at(-1)?.commit).toBeTruthy();

    const hostGit = simpleGit({ baseDir: worktreePath });
    await writeFile(path.join(worktreePath, 'host.txt'), faker.lorem.sentence());
    await hostGit.add('-A').commit(faker.git.commitMessage());
    const unapproved = await hostGit.revparse(['HEAD']);

    agent.script('describer', aDescription());

    const { status, state } = await run(saved ?? start);

    expect(status).toBe('blocked');
    expect(state.blockedReason).toBeTruthy();
    expect(state.finalCheck).toMatchObject({ fulfilled: true, round: 2 });
    expect((await git.log(['main'])).all).toHaveLength(1);
    expect(await git.revparse([runBranch])).toBe(unapproved);
  });

  it('describes the run and stops for a person when the repaired run still fails its final check', async () => {
    const { agent, run, start, git } = await setup({ settings: runSettings() });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'fix.txt': faker.lorem.sentence() } },
    );
    agent.script(
      'reviewer',
      approval(),
      unfulfilled(faker.lorem.sentence()),
      approval(),
      unfulfilled(faker.lorem.sentence()),
    );
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('stuck');
    expect(state.finalCheck).toMatchObject({ fulfilled: false, round: 2 });
    expect(state.slices.every((slice) => slice.status === 'approved')).toBe(true);
    expect(state.prDescription).toBeTruthy();
    expect((await git.log(['main'])).all).toHaveLength(1);
  });

  it('sends the run back with the failed verification when its final check cannot verify it', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const failure = faker.lorem.sentence();
    const results: ExecResult[] = [
      { exitCode: 0, output: faker.lorem.sentence() },
      { exitCode: 1, output: failure },
      { exitCode: 0, output: faker.lorem.sentence() },
      { exitCode: 0, output: faker.lorem.sentence() },
    ];
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => results.shift() ?? { exitCode: 1, output: '' },
    });
    scriptPlanning(agent, [slice]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'fix.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', approval(), fulfillment(), approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(agent.commands).toEqual([verifyCommand, verifyCommand, verifyCommand, verifyCommand]);
    expect(state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 2 });
    expect(agent.calls.filter((call) => call.role === 'implementer')[1].prompt).toContain(failure);
  });

  it('sends the repair one description carrying the failed verification and the reviewer gaps', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const failure = faker.lorem.sentence();
    const gap = faker.lorem.sentence();
    const results: ExecResult[] = [
      { exitCode: 0, output: faker.lorem.sentence() },
      { exitCode: 1, output: failure },
      { exitCode: 0, output: faker.lorem.sentence() },
      { exitCode: 0, output: faker.lorem.sentence() },
    ];
    const { agent, run, start } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => results.shift() ?? { exitCode: 1, output: '' },
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'fix.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', approval(), unfulfilled(gap), approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    const repair = state.slices[1];
    expect(repair).toMatchObject({ id: 'final-fixes', status: 'approved' });
    expect(repair.description).toContain(failure);
    expect(repair.description).toContain(gap);
    const prompted = agent.calls.filter((call) => call.role === 'implementer')[1].prompt;
    expect(prompted).toContain(failure);
    expect(prompted).toContain(gap);
  });

  it('describes a run whose repair ran out of review cycles and stops for a person without merging it', async () => {
    const { agent, run, start, git } = await setup({
      settings: runSettings({ reviewCycleCap: 1 }),
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'fix.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', approval(), unfulfilled(faker.lorem.sentence()), rejection());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('stuck');
    expect(state.finalCheck).toMatchObject({ fulfilled: false, round: 1 });
    expect(state.slices[1]).toMatchObject({ id: 'final-fixes', status: 'stuck', reviewCycles: 1 });
    expect(state.prDescription).toBeTruthy();
    expect((await git.log(['main'])).all).toHaveLength(1);
  });

  it('resumes from the saved repair and appends no second one when the recheck fails again', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const crash = new Error(faker.lorem.sentence());
    const { agent, run, start, store, git } = await setup({ settings: runSettings() });
    scriptPlanning(agent, [slice]);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } }, { crash });
    agent.script('reviewer', approval(), unfulfilled(faker.lorem.sentence()));

    await expect(run(start)).rejects.toThrow(Panic);
    const saved = (await store.load(start.runId)).unwrap();
    expect(saved?.phase).toBe('slices');
    expect(saved?.finalCheck).toMatchObject({ fulfilled: false, round: 1 });
    expect(saved?.slices.map((entry) => entry.id)).toEqual([slice.id, 'final-fixes']);

    agent.script('implementer', { files: { 'fix.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approval(), unfulfilled(faker.lorem.sentence()));
    agent.script('describer', aDescription());

    const { status, state } = await run(saved ?? start);

    expect(status).toBe('stuck');
    expect(state.slices.map((entry) => entry.id)).toEqual([slice.id, 'final-fixes']);
    expect(state.finalCheck).toMatchObject({ fulfilled: false, round: 2 });
    expect((await git.log(['main'])).all).toHaveLength(1);
  });

  it('resumes a saved run whose repair the reviewer approved, and appends no second repair when the recheck fails again', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const crash = new Error(faker.lorem.sentence());
    const { agent, run, start, store, git } = await setup({ settings: runSettings() });
    scriptPlanning(agent, [slice]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'fix.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', approval(), unfulfilled(faker.lorem.sentence()), approval(), {
      crash,
    });

    await expect(run(start)).rejects.toThrow(Panic);
    const saved = (await store.load(start.runId)).unwrap();
    expect(saved?.phase).toBe('finalCheck');
    expect(saved?.slices.map((entry) => entry.id)).toEqual([slice.id, 'final-fixes']);
    expect(saved?.slices[1]).toMatchObject({ id: 'final-fixes', status: 'approved' });
    expect(saved?.slices[1].commit).toBeTruthy();

    agent.script('reviewer', unfulfilled(faker.lorem.sentence()));
    agent.script('describer', aDescription());

    const { status, state } = await run(saved ?? start);

    expect(status).toBe('stuck');
    expect(state.slices.map((entry) => entry.id)).toEqual([slice.id, 'final-fixes']);
    expect(state.slices[1]).toMatchObject({ id: 'final-fixes', status: 'approved' });
    expect(state.finalCheck).toMatchObject({ fulfilled: false, round: 2 });
    expect(state.prDescription).toBeTruthy();
    expect((await git.log(['main'])).all).toHaveLength(1);
  });

  it('slices the design the first review approves without asking the planner to revise it', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({ settings: runSettings() });
    const docs = scriptDesign(agent);
    agent.script('reviewer', designApproval());
    agent.script('planner', { output: [slice] });
    scriptDelivery(agent, [slice]);

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.docs).toEqual(docs);
    expect(state.designReview).toEqual({ reviews: [{ findings: [] }] });
    const plannerCalls = agent.calls.filter((call) => call.role === 'planner');
    expect(plannerCalls).toHaveLength(4);
    expect(plannerCalls[3].prompt).toContain(docs.plan);
  });

  it('sends the findings to the planner and slices the revised plan the re-review approves', async () => {
    const finding = aDesignFinding();
    const revised = designDocs({ plan: planWithSteps(1, 2) });
    const slices = [
      aPlannedSlice({ description: implementingPlanSteps(1) }),
      aPlannedSlice({ description: implementingPlanSteps(2) }),
    ];
    const { agent, run, start } = await setup({ settings: runSettings() });
    const reviewed = scriptDesign(agent);
    agent.script('reviewer', designFindings(finding), designApproval());
    agent.script('planner', designRevision(revised, [aDisposition(finding, 'addressed')]), {
      output: slices,
    });
    scriptDelivery(agent, slices);

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.docs).toEqual(revised);
    expect(state.slices.map((slice) => slice.id)).toEqual(slices.map((slice) => slice.id));
    const [revision, slicing] = agent.calls.filter((call) => call.role === 'planner').slice(3);
    expect(revision.prompt).toContain(finding.failureScenario);
    expect(slicing.prompt).toContain(revised.plan);
    expect(slicing.prompt).not.toContain(reviewed.plan);
    const reReview = agent.calls.filter((call) => call.role === 'reviewer')[1];
    expect(reReview.prompt).toContain(reviewed.plan);
    expect(reReview.prompt).toContain(revised.plan);
  });

  it('goes on to slicing when the re-review accepts the planner dispute', async () => {
    const finding = aDesignFinding();
    const dispute = {
      findingId: finding.id,
      status: 'disputed' as const,
      reasoning: faker.lorem.sentence(),
      evidence: [faker.lorem.sentence()],
    };
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({ settings: runSettings() });
    const docs = scriptDesign(agent);
    agent.script('reviewer', designFindings(finding), designApproval());
    agent.script('planner', designRevision(docs, [dispute]), { output: [slice] });
    scriptDelivery(agent, [slice]);

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.designReview?.revision?.dispositions).toEqual([dispute]);
    const reReview = agent.calls.filter((call) => call.role === 'reviewer')[1];
    expect(reReview.prompt).toContain(dispute.reasoning);
  });

  it.each(['auto', 'checkpoint'] as const)(
    'blocks before slicing on a finding the re-review still raises, with the %s design gate',
    async (designGate) => {
      const finding = aDesignFinding({ resolution: 'operatorDecision' });
      const { agent, run, start, store, runBranchHistory } = await setup({
        settings: runSettings({ designGate }),
      });
      const docs = scriptDesign(agent);
      agent.script('reviewer', designFindings(finding), designFindings(finding));
      agent.script('planner', designRevision(docs, [aDisposition(finding)]));

      const blocked = await run(start);

      expect(blocked.status).toBe('blocked');
      expect(blocked.state.phase).toBe('resolvingDesign');
      expect(blocked.state.blockedReason).toContain(finding.id);
      expect(blocked.state.blockedReason).toContain(finding.concern);
      const saved = (await store.load(start.runId)).unwrap();
      expect(saved?.designReview?.reviews).toEqual([
        { findings: [finding] },
        { findings: [finding] },
      ]);
      expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(4);
      expect(agent.calls.some((call) => call.role === 'implementer')).toBe(false);
      expect(await runBranchHistory()).toBe('');
    },
  );

  it('blocks on a problem the revision introduced even when it settled the original finding', async () => {
    const [original, introduced] = [aDesignFinding(), aDesignFinding()];
    const { agent, run, start } = await setup({ settings: runSettings() });
    scriptDesign(agent);
    agent.script('reviewer', designFindings(original), designFindings(introduced));
    agent.script('planner', designRevision(designDocs(), [aDisposition(original, 'addressed')]));

    const { status, state } = await run(start);

    expect(status).toBe('blocked');
    expect(state.blockedReason).toContain(introduced.id);
    expect(state.blockedReason).not.toContain(original.id);
  });

  it('keeps a blocked design blocked on resume without another revision or review', async () => {
    const finding = aDesignFinding();
    const { agent, run, start } = await setup({ settings: runSettings() });
    const docs = scriptDesign(agent);
    agent.script('reviewer', designFindings(finding), designFindings(finding));
    agent.script('planner', designRevision(docs, [aDisposition(finding)]));
    const blocked = await run(start);
    const callsWhenBlocked = agent.calls.length;

    const resumed = await run(blocked.state);

    expect(resumed.status).toBe('blocked');
    expect(resumed.state.phase).toBe('resolvingDesign');
    expect(resumed.state.blockedReason).toContain(finding.id);
    expect(agent.calls).toHaveLength(callsWhenBlocked);
  });

  it('resumes an interrupted re-review without granting the planner another revision', async () => {
    const finding = aDesignFinding();
    const revised = designDocs();
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start, store } = await setup({ settings: runSettings() });
    scriptDesign(agent);
    agent.script('reviewer', designFindings(finding), { crash: new Error(faker.lorem.sentence()) });
    agent.script('planner', designRevision(revised, [aDisposition(finding)]));

    await expect(run(start)).rejects.toThrow(Panic);
    const saved = (await store.load(start.runId)).unwrap();
    expect(saved).toMatchObject({ phase: 'reviewingDesign', docs: revised });
    agent.script('reviewer', designApproval());
    agent.script('planner', { output: [slice] });
    scriptDelivery(agent, [slice]);
    const plannerCallsBeforeResume = agent.calls.filter((call) => call.role === 'planner').length;

    const { status, state } = await run(saved ?? start);

    expect(status).toBe('done');
    expect(state.designReview?.reviews).toHaveLength(2);
    expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(
      plannerCallsBeforeResume + 1,
    );
  });

  it('blocks a run whose design reviewer keeps replying malformed, before any slicing', async () => {
    const maxStepRetries = faker.number.int({ min: 0, max: 2 });
    const { agent, run, start } = await setup({ settings: runSettings({ maxStepRetries }) });
    scriptDesign(agent);
    agent.script(
      'reviewer',
      ...Array.from({ length: maxStepRetries + 1 }, () => malformedVerdict()),
    );

    const { status, state } = await run(start);

    expect(status).toBe('blocked');
    expect(state.phase).toBe('reviewingDesign');
    expect(state.designReview).toBeUndefined();
    expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(3);
  });

  it('blocks a revision that leaves a finding unanswered, before any slicing or implementation', async () => {
    const [answered, skipped] = [aDesignFinding(), aDesignFinding()];
    const { agent, run, start } = await setup({ settings: runSettings({ maxStepRetries: 0 }) });
    scriptDesign(agent);
    agent.script('reviewer', designFindings(answered, skipped));
    agent.script('planner', designRevision(designDocs(), [aDisposition(answered)]));

    const { status, state } = await run(start);

    expect(status).toBe('blocked');
    expect(state.phase).toBe('revisingDesign');
    expect(state.blockedReason).toContain(skipped.id);
    expect(state.designReview?.revision).toBeUndefined();
    expect(agent.calls.some((call) => call.role === 'implementer')).toBe(false);
  });

  it('pauses at the checkpoint with the revised design, then delivers its slices on resume', async () => {
    const finding = aDesignFinding();
    const revised = designDocs();
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({
      settings: runSettings({ designGate: 'checkpoint' }),
    });
    scriptDesign(agent);
    agent.script('reviewer', designFindings(finding), designApproval());
    agent.script('planner', designRevision(revised, [aDisposition(finding)]), { output: [slice] });

    const paused = await run(start);
    expect(paused).toMatchObject({ status: 'halted', state: { phase: 'paused', docs: revised } });

    scriptDelivery(agent, [slice]);
    const resumed = await run(paused.state);

    expect(resumed.status).toBe('done');
    expect(resumed.state.slices.map((entry) => entry.id)).toEqual([slice.id]);
    expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(5);
  });

  it('resumes a run saved after the first review with the one revision and one re-review', async () => {
    const finding = aDesignFinding();
    const revised = designDocs();
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({ settings: runSettings() });
    const saved = aRunState({
      runId: start.runId,
      phase: 'revisingDesign',
      designReview: aFirstDesignReview({ findings: [finding] }),
    });
    agent.script('planner', designRevision(revised, [aDisposition(finding)]), { output: [slice] });
    agent.script('reviewer', designApproval());
    scriptDelivery(agent, [slice]);

    const { status, state } = await run(saved);

    expect(status).toBe('done');
    expect(state.docs).toEqual(revised);
    expect(state.designReview?.reviews).toEqual([{ findings: [finding] }, { findings: [] }]);
    expect(state.designReview?.revision?.reviewedDocs).toEqual(saved.docs);
    const plannerCalls = agent.calls.filter((call) => call.role === 'planner');
    expect(plannerCalls).toHaveLength(2);
    expect(plannerCalls[0].prompt).toContain(finding.failureScenario);
    expect(agent.calls.filter((call) => call.role === 'reviewer')[0].prompt).toContain(
      revised.plan,
    );
  });

  it('resumes a run saved after the revision with the re-review alone, slicing the revised documents', async () => {
    const progress = aRevisionAwaitingReReview();
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({ settings: runSettings() });
    const saved = aRunState({
      runId: start.runId,
      phase: 'reviewingDesign',
      designReview: progress,
    });
    agent.script('reviewer', designApproval());
    agent.script('planner', { output: [slice] });
    scriptDelivery(agent, [slice]);

    const { status, state } = await run(saved);

    expect(status).toBe('done');
    expect(state.docs).toEqual(saved.docs);
    expect(state.designReview).toEqual({
      ...progress,
      reviews: [...progress.reviews, { findings: [] }],
    });
    const [slicing] = agent.calls.filter((call) => call.role === 'planner');
    expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(1);
    expect(slicing.prompt).toContain(saved.docs?.plan);
    expect(slicing.prompt).not.toContain(progress.revision?.reviewedDocs.plan);
    const [reReview] = agent.calls.filter((call) => call.role === 'reviewer');
    expect(reReview.prompt).toContain(progress.revision?.reviewedDocs.plan);
  });

  it.each([
    ['its approved design review', anApprovedDesignReview()],
    ['no design review, saved before there were any', undefined],
  ])(
    'slices a run saved at slicing with %s without reviewing the design',
    async (_kind, progress) => {
      const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
      const { agent, run, start } = await setup({ settings: runSettings() });
      const saved = aRunState({ runId: start.runId, phase: 'slicing', designReview: progress });
      agent.script('planner', { output: [slice] });
      scriptDelivery(agent, [slice]);

      const { status, state } = await run(saved);

      expect(status).toBe('done');
      expect(state.designReview).toEqual(progress);
      expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(1);
      expect(agent.calls.filter((call) => call.role === 'reviewer')).toHaveLength(2);
    },
  );

  it('stays blocked on an unresolved design however often it is resumed, calling no agent', async () => {
    const progress = aRevisedDesignReview();
    const { agent, run, start, store } = await setup({ settings: runSettings() });
    const saved = aRunState({
      runId: start.runId,
      phase: 'resolvingDesign',
      designReview: progress,
    });

    const first = await run(saved);
    const second = await run(first.state);

    for (const resumed of [first, second]) {
      expect(resumed.status).toBe('blocked');
      expect(resumed.state.phase).toBe('resolvingDesign');
      expect(resumed.state.designReview).toEqual(progress);
      for (const finding of progress.reviews[1].findings) {
        expect(resumed.state.blockedReason).toContain(finding.id);
      }
    }
    expect(agent.calls).toHaveLength(0);
    expect((await store.load(start.runId)).unwrap()?.designReview).toEqual(progress);
  });

  it('retries a failed re-review call within the cap, since a failed call is not a completed review', async () => {
    const finding = aDesignFinding();
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({ settings: runSettings({ maxStepRetries: 1 }) });
    scriptDesign(agent);
    agent.script(
      'reviewer',
      designFindings(finding),
      { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) },
      designApproval(),
    );
    agent.script('planner', designRevision(designDocs(), [aDisposition(finding)]), {
      output: [slice],
    });
    scriptDelivery(agent, [slice]);

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.designReview?.reviews).toEqual([{ findings: [finding] }, { findings: [] }]);
    expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(5);
  });

  it('asks the planner again on resume for a revision whose call failed and was never saved', async () => {
    const finding = aDesignFinding();
    const revised = designDocs();
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({ settings: runSettings({ maxStepRetries: 0 }) });
    scriptDesign(agent);
    agent.script('reviewer', designFindings(finding));
    agent.script('planner', { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) });
    const blocked = await run(start);
    expect(blocked).toMatchObject({ status: 'blocked', state: { phase: 'revisingDesign' } });
    agent.script('planner', designRevision(revised, [aDisposition(finding)]), { output: [slice] });
    agent.script('reviewer', designApproval());
    scriptDelivery(agent, [slice]);

    const { status, state } = await run(blocked.state);

    expect(status).toBe('done');
    expect(state.docs).toEqual(revised);
    expect(state.designReview?.reviews).toEqual([{ findings: [finding] }, { findings: [] }]);
  });

  it('reviews the design again on resume when its review could not be saved', async () => {
    const failure = new RunStateConflict({ message: faker.lorem.sentence() });
    const memory = new InMemoryRunStore();
    const failFirstSaveOfAReview = vi.fn(async (state: RunState) =>
      state.designReview &&
      failFirstSaveOfAReview.mock.calls.filter(([saved]) => saved.designReview).length === 1
        ? Result.err(failure)
        : memory.save(state),
    );
    const store = mock<RunStore>({ load: (id) => memory.load(id), save: failFirstSaveOfAReview });
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, invoke, run, start } = await setup({ settings: runSettings(), store });
    scriptDesign(agent);
    agent.script('reviewer', designFindings(aDesignFinding()));

    const unsaved = await invoke(start);

    expect(unsaved.isErr() && unsaved.error).toBe(failure);
    const saved = (await memory.load(start.runId)).unwrap();
    expect(saved).toMatchObject({ phase: 'reviewingDesign' });
    expect(saved?.designReview).toBeUndefined();
    agent.script('reviewer', designApproval());
    agent.script('planner', { output: [slice] });
    scriptDelivery(agent, [slice]);
    const plannerCallsBeforeResume = agent.calls.filter((call) => call.role === 'planner').length;

    const { status, state } = await run(saved ?? start);

    expect(status).toBe('done');
    expect(state.designReview).toEqual({ reviews: [{ findings: [] }] });
    expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(
      plannerCallsBeforeResume + 1,
    );
  });

  it('checks the slices against the revised plan and takes their one coverage correction', async () => {
    const progress = aRevisionAwaitingReReview();
    const revised = designDocs({ plan: planWithSteps(1, 2) });
    const partial = [aPlannedSlice({ description: implementingPlanSteps(1) })];
    const corrected = [
      aPlannedSlice({ description: implementingPlanSteps(1) }),
      aPlannedSlice({ description: implementingPlanSteps(2) }),
    ];
    const { agent, run, start } = await setup({ settings: runSettings() });
    const saved = aRunState({
      runId: start.runId,
      phase: 'reviewingDesign',
      docs: revised,
      designReview: progress,
    });
    agent.script('reviewer', designApproval());
    agent.script('planner', { output: partial }, { output: corrected });
    scriptDelivery(agent, corrected);

    const { status, state } = await run(saved);

    expect(status).toBe('done');
    expect(state.slices.map((slice) => slice.id)).toEqual(corrected.map((slice) => slice.id));
    expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(2);
  });

  it('writes and reviews the design of a run saved in designing before there were reviews, without planning again', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({ settings: runSettings() });
    const saved = aRunState({ runId: start.runId, phase: 'designing' });
    agent.script('planner', { output: designDocs() }, { output: [slice] });
    agent.script('reviewer', designApproval());
    scriptDelivery(agent, [slice]);

    const { status, state } = await run(saved);

    expect(status).toBe('done');
    expect(state).toMatchObject({ context: saved.context, plan: saved.plan });
    expect(state.designReview).toEqual({ reviews: [{ findings: [] }] });
    expect(agent.calls.filter((call) => call.role === 'planner')).toHaveLength(2);
  });

  it.each(['gate', 'paused', 'slices'] as const)(
    'delivers the slices of a run saved in %s before there were design reviews, without planning or reviewing the design',
    async (phase) => {
      const slice = aSlice({ status: 'pending' });
      const { agent, run, start } = await setup({ settings: runSettings() });
      const saved = aRunState({ runId: start.runId, phase, slices: [slice] });
      agent.script('implementer', { files: { [`${slice.id}.txt`]: faker.lorem.sentence() } });
      agent.script('reviewer', approval(), fulfillment());
      agent.script('describer', aDescription());

      const { status, state } = await run(saved);

      expect(status).toBe('done');
      expect(state.designReview).toBeUndefined();
      expect(state.slices.map((each) => [each.id, each.status])).toEqual([[slice.id, 'approved']]);
      expect(agent.calls.some((call) => call.role === 'planner')).toBe(false);
      expect(agent.calls.filter((call) => call.role === 'reviewer')).toHaveLength(2);
    },
  );

  it.each([
    ['finalCheck', 1],
    ['describing', 0],
    ['merging', 0],
    ['awaitingMerge', 0],
  ] as const)(
    'finishes a run saved in %s before there were design reviews, without planning or reviewing the design',
    async (phase, finalChecks) => {
      const { agent, run, start } = await setup({ settings: runSettings() });
      const saved = aRunState({
        runId: start.runId,
        phase,
        slices: [aSlice({ status: 'approved' })],
      });
      agent.script('reviewer', fulfillment());
      agent.script('describer', aDescription());

      const { status, state } = await run(saved);

      expect(status).toBe('done');
      expect(state.designReview).toBeUndefined();
      expect(agent.calls.some((call) => call.role === 'planner')).toBe(false);
      expect(agent.calls.filter((call) => call.role === 'reviewer')).toHaveLength(finalChecks);
    },
  );

  it.each(['done', 'stuck'] as const)(
    'leaves a run saved as %s before there were design reviews where it ended',
    async (phase) => {
      const { agent, run, start } = await setup({ settings: runSettings() });
      const saved = aRunState({ runId: start.runId, phase });

      const { status, state } = await run(saved);

      expect(status).toBe(phase);
      expect(state).toEqual({ ...saved, blockedReason: undefined });
      expect(agent.calls).toHaveLength(0);
    },
  );

  async function setup(input: {
    settings: RunSettings;
    exec?: (command: string) => ExecResult | SandboxUnavailable;
    store?: RunStore;
  }) {
    const id = runId();
    const { sandboxPath, workspace, git, runBranch, worktreePath, rejectCommitsInSandbox } =
      await createRunWorktree(id);
    const agent = new FakeAgentSession(sandboxPath, input.exec);
    const store = input.store ?? new InMemoryRunStore();
    const dependencies = {
      ports: { agent, workspace },
      store,
      events: new RecordingEventSink(),
      clock: new SteppingClock(),
      settings: input.settings,
    };
    const start = startRun({ runId: id, baseBranch: 'main', request: faker.lorem.paragraph() });
    const invoke = (state: RunState) => runEngine(runFlow, state, dependencies);
    const run = async (state: RunState) => (await invoke(state)).unwrap();
    const runBranchHistory = () =>
      git.raw(['log', '--reverse', '--format=%s', '--patch', `main..${runBranch}`]);
    return {
      agent,
      invoke,
      run,
      start,
      store,
      git,
      runBranch,
      worktreePath,
      runBranchHistory,
      sandboxPath,
      rejectCommitsInSandbox,
    };
  }
});

/** Scripts the planner's context, feature plan and the design documents it writes. */
function scriptDesign(agent: FakeAgentSession, docs = designDocs()) {
  agent.script('planner', { output: aContext() }, { output: aFeaturePlan() }, { output: docs });
  return docs;
}

/** Scripts each slice implemented and approved, the final check fulfilled, and the description. */
function scriptDelivery(agent: FakeAgentSession, slices: PlannedSlice[]) {
  agent.script(
    'implementer',
    ...slices.map((slice) => ({ files: { [`${slice.id}.txt`]: faker.lorem.sentence() } })),
  );
  agent.script('reviewer', ...slices.map(() => approval()), fulfillment());
  agent.script('describer', aDescription());
}

/** The reviewer's calls once the design review that every planned run starts with is done. */
function reviewsAfterDesign(agent: FakeAgentSession) {
  return agent.calls.filter((call) => call.role === 'reviewer').slice(1);
}

function malformedVerdict() {
  return { output: { verdict: faker.lorem.word() } };
}
