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
  approvalLeavingGaps,
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
  failureOutput,
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
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { runDiagnostics } from '../domain/run-diagnostics.js';
import { enterPhase, type RunState, startRun } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { PlannedSlice } from '../domain/slice.js';
import { runEngine } from '../flow/engine.js';
import { AgentRunFailed, type ExecResult, SandboxUnavailable } from '../ports/agent-session.js';
import { RunStateConflict } from '../ports/run-state-failures.js';
import type { RunStore } from '../ports/run-store.js';
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

  it('ends a run that skips the merge as completed, with its commits on the run branch only', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start, git, runBranch, workspace } = await setup({
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
    const { agent, run, start, events } = await setup({
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
    const { agent, run, start } = await setup({ settings: runSettings({ reviewCycleCap: 1 }) });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', rejection());
    agent.script('describer', aDescription());

    const { status } = await run({ ...start, merge: false });

    expect(status).toBe('stuck');
  });

  it('halts a run that skips the merge at the design checkpoint and completes it on resume', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({
      settings: runSettings({ designGate: 'checkpoint' }),
    });
    scriptPlanning(agent, [slice]);

    const paused = await run({ ...start, merge: false });
    expect(paused).toMatchObject({ status: 'halted', state: { phase: 'paused' } });

    scriptDelivery(agent, [slice]);
    const resumed = await run(paused.state);
    expect(resumed.status).toBe('completed');
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
      expect(resumed.state.slices[0].lastFeedback).toBeTruthy();
      for (const line of resumed.state.slices[0].lastFeedback?.split('\n') ?? []) {
        expect(resumed.state.prDescription).toContain(line);
      }
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

  it('verifies a slice before the reviewer sees it, and finishes on that one verification and one review', async () => {
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
    agent.script('reviewer', approval());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(agent.commands).toEqual([verifyCommand]);
    expect(reviewerCallsWhenCommandRan).toEqual([0]);
    expect(reviewsAfterDesign(agent)).toHaveLength(1);
    expect(state.finalCheck).toBeUndefined();
    expect(state.completionReuseAuthorized).toBe(true);
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
    agent.script('reviewer', approval());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.slices[0]).toMatchObject({
      status: 'approved',
      reviewCycles: 0,
      verificationFailures: 1,
      verification: { command: verifyCommand },
    });
    expect(agent.commands).toEqual([verifyCommand, verifyCommand]);
    expect(reviewerCallsWhenCommandRan).toEqual([0, 0]);
    expect(reviewsAfterDesign(agent)).toHaveLength(1);
    const retryPrompt = agent.calls.filter((call) => call.role === 'implementer')[1].prompt;
    expect(retryPrompt).toContain(failure);
    expect(retryPrompt).toContain(verifyCommand);
    expect(state.slices[0]).toMatchObject({ hookFailures: 0, emptyAttempts: 0, ruleFixCycles: 0 });
    expect(state.completionReuseAuthorized).toBe(true);
    expect(state.finalCheck).toBeUndefined();
  });

  it('leaves a slice stuck after three verification failures independently of the review cap', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const failure = faker.lorem.sentence();
    const { agent, run, start } = await setup({
      settings: runSettings({ reviewCycleCap: 1, verifyCommand }),
      exec: () => ({ exitCode: 1, output: failure }),
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
      hookFailures: 0,
      emptyAttempts: 0,
      ruleFixCycles: 0,
    });
    expect(state.slices[0].lastFeedback).toContain(verifyCommand);
    expect(state.slices[0].lastFeedback).toContain(failure);
    expect(state.slices[0].feedbackHistory).toHaveLength(3);
    expect(state.prDescription).toContain(verifyCommand);
    expect(state.prDescription).toContain(failure);
    for (const call of agent.calls.filter((call) => call.role === 'implementer').slice(1)) {
      expect(call.prompt).toContain(verifyCommand);
      expect(call.prompt).toContain(failure);
    }
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

  it('records the whole-request evidence of an eligible slice review and still runs the final check', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setup({ settings: runSettings() });
    scriptPlanning(agent, [slice]);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.completionReuse).toMatchObject({ verdict: { fulfilled: true, gaps: [] } });
    const [sliceReview, finalCheck] = reviewsAfterDesign(agent);
    expect(sliceReview.prompt).toContain(state.request);
    expect(sliceReview.prompt).toContain(state.docs?.plan);
    expect(finalCheck.prompt).toContain(state.request);
    expect(state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 1 });
  });

  it('describes a reused completion with the work, range and verification it rests on', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, start } = await setup({ settings: runSettings({ verifyCommand }) });
    scriptReusedRun(agent);

    const { state } = await run(start);

    const evidence = state.completionReuse;
    expect(evidence).toBeDefined();
    expect(state.prDescription).toContain(evidence?.checked.commit);
    expect(state.prDescription).toContain(
      `${evidence?.scope.range.start}...${evidence?.scope.range.end}`,
    );
  });

  it('resumes a run waiting for its merge on the same reused completion, running nothing again', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, start } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
    });
    scriptReusedRun(agent);
    const halted = await run(start);
    const callsBefore = agent.calls.length;

    const resumed = await run(halted.state);

    expect(resumed.status).toBe('halted');
    expect(resumed.state).toMatchObject({
      phase: 'awaitingMerge',
      completionReuseAuthorized: true,
      prDescription: halted.state.prDescription,
    });
    expect(resumed.state.finalCheck).toBeUndefined();
    expect(agent.calls).toHaveLength(callsBefore);
    expect(agent.commands).toEqual([verifyCommand]);
  });

  it('falls back to an ordinary final check when the reused evidence breaks while the run waits for its merge', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, start, sandboxPath, events } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
    });
    scriptReusedRun(agent);
    const halted = await run(start);
    await writeFile(path.join(sandboxPath, `${faker.string.uuid()}.txt`), faker.lorem.sentence());
    agent.script('reviewer', fulfillment());
    agent.script('describer', aDescription());

    const resumed = await run(halted.state);

    expect(resumed.status).toBe('halted');
    expect(resumed.state.completionReuseAuthorized).toBeUndefined();
    expect(resumed.state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 1 });
    expect(resumed.state.prDescription).not.toBe(halted.state.prDescription);
    expect(agent.commands).toEqual([verifyCommand, verifyCommand]);
    expect(events.ofType('phaseChanged')).toContainEqual(
      expect.objectContaining({ from: 'merging', to: 'finalCheck' }),
    );
  });

  it('falls back to an ordinary final check when the reused evidence breaks before the run is described', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const store = new InMemoryRunStore();
    const { agent, run, start, sandboxPath } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
      store,
    });
    scriptReusedRun(agent);
    await run(start);
    const describing = store.saved.find(
      (saved) => saved.phase === 'describing' && saved.completionReuseAuthorized,
    );
    if (!describing) panic('The run never saved its reused completion before describing it');
    await writeFile(path.join(sandboxPath, `${faker.string.uuid()}.txt`), faker.lorem.sentence());
    agent.script('reviewer', fulfillment());
    agent.script('describer', aDescription());
    const describersBefore = agent.calls.filter((call) => call.role === 'describer').length;

    const { status, state } = await run(describing);

    expect(status).toBe('halted');
    expect(state.completionReuseAuthorized).toBeUndefined();
    expect(state.finalCheck).toMatchObject({ round: 1 });
    expect(agent.calls.filter((call) => call.role === 'describer')).toHaveLength(
      describersBefore + 1,
    );
  });

  it('keeps the one repair and the stuck ending for a final check reached by invalidated evidence', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, start, sandboxPath, git } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
    });
    scriptReusedRun(agent);
    const halted = await run(start);
    await writeFile(path.join(sandboxPath, `${faker.string.uuid()}.txt`), faker.lorem.sentence());
    agent.script('reviewer', unfulfilled(faker.lorem.sentence()));
    agent.script('implementer', { files: { 'fix.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approval(), unfulfilled(faker.lorem.sentence()));
    agent.script('describer', aDescription());

    const { status, state } = await run(halted.state);

    expect(status).toBe('stuck');
    expect(state.slices.map((slice) => slice.status)).toEqual(['approved', 'approved']);
    expect(state.finalCheck).toMatchObject({ fulfilled: false, round: 2 });
    expect((await git.log(['main'])).all).toHaveLength(1);
  });

  it('resumes a reloaded run waiting for its merge on the same reused completion, repeating no verification, review or description', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, reload, start } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
    });
    scriptReusedRun(agent);
    const halted = await run(start);
    const callsBefore = agent.calls.length;

    const resumed = await run(await reload(halted.state));

    expect(resumed.state).toMatchObject({
      phase: 'awaitingMerge',
      completionReuse: halted.state.completionReuse,
      completionReuseAuthorized: true,
      prDescription: halted.state.prDescription,
    });
    expect(agent.calls).toHaveLength(callsBefore);
    expect(agent.commands).toEqual([verifyCommand]);
  });

  it('records an already merged reused run as done even when its sources have changed', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, reload, start, git, runBranch } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
    });
    scriptReusedRun(agent);
    const halted = await run(start);
    await git.merge([runBranch, '--no-edit']);
    const callsBefore = agent.calls.length;

    const { status, state } = await run(
      await reload({ ...halted.state, request: faker.lorem.paragraph() }),
    );

    expect(status).toBe('done');
    expect(state.completionReuse).toEqual(halted.state.completionReuse);
    expect(state.finalCheck).toBeUndefined();
    expect(agent.calls).toHaveLength(callsBefore);
    expect(agent.commands).toEqual([verifyCommand]);
  });

  it.each(['done', 'stuck'] as const)(
    'preserves a serialized %s run carrying stale authorized completion evidence',
    async (phase) => {
      const verifyCommand = `npm run ${faker.word.verb()}`;
      const { agent, run, reload, start } = await setup({
        settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
      });
      scriptReusedRun(agent);
      const halted = await run(start);
      const saved = await reload(
        enterPhase({ ...halted.state, request: faker.lorem.paragraph() }, phase),
      );
      const callsBefore = agent.calls.length;

      const { status, state } = await run(saved);

      expect(status).toBe(phase);
      expect(state).toEqual({ ...saved, blockedReason: undefined });
      expect(agent.calls).toHaveLength(callsBefore);
      expect(agent.commands).toEqual([verifyCommand]);
    },
  );

  it.each(
    (
      [
        ['request', (state: RunState) => ({ ...state, request: faker.lorem.paragraph() })],
        [
          'plan',
          (state: RunState) => ({
            ...state,
            docs: { ...designDocs(), plan: faker.lorem.paragraph() },
          }),
        ],
        [
          'range',
          (state: RunState) => ({
            ...state,
            completionReuse: state.completionReuse && {
              ...state.completionReuse,
              scope: {
                ...state.completionReuse.scope,
                range: { ...state.completionReuse.scope.range, start: faker.git.commitSha() },
              },
            },
          }),
        ],
      ] as const
    ).flatMap(([source, change]) =>
      (['describing', 'merging', 'awaitingMerge'] as const).map((phase) => ({
        source,
        change,
        phase,
      })),
    ),
  )(
    'runs a final check when $source changes before $phase, retaining evidence and the repair allowance',
    async ({ change, phase }) => {
      const verifyCommand = `npm run ${faker.word.verb()}`;
      const store = new InMemoryRunStore();
      const { agent, run, reload, start } = await setup({
        settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
        store,
      });
      scriptReusedRun(agent);
      const halted = await run(start);
      if (halted.state.phase !== 'awaitingMerge') panic('The run never reached its manual merge');
      const saved = store.saved.find(
        (state) => state.phase === phase && state.completionReuseAuthorized,
      );
      if (!saved) panic(`The run never saved authorized evidence before ${phase}`);
      const changed = change({ ...saved, prDescription: halted.state.prDescription });
      const savesBefore = store.saved.length;
      agent.script('reviewer', fulfillment());
      agent.script('describer', aDescription());

      const resumed = await run(await reload(changed));

      const invalidated = store.saved
        .slice(savesBefore)
        .find((state) => state.phase === 'finalCheck');
      expect(invalidated).toMatchObject({ completionReuse: changed.completionReuse });
      expect(invalidated?.completionReuseAuthorized).toBeUndefined();
      expect(invalidated?.prDescription).toBeUndefined();
      expect(invalidated?.finalCheck).toBeUndefined();
      expect(resumed.status).toBe('halted');
      expect(resumed.state.completionReuse).toEqual(changed.completionReuse);
      expect(resumed.state.completionReuseAuthorized).toBeUndefined();
      expect(resumed.state.prDescription).not.toBe(halted.state.prDescription);
      expect(resumed.state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 1 });
      expect(resumed.state.slices).toHaveLength(1);
      expect(agent.commands).toEqual([verifyCommand, verifyCommand]);
    },
  );

  it('runs an ordinary final check on a reloaded legacy run that never recorded completion evidence', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const store = new InMemoryRunStore();
    const { agent, run, reload, start } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
      store,
    });
    scriptReusedRun(agent);
    await run(start);
    const deciding = store.saved.find((saved) => saved.phase === 'checkingReuse');
    if (!deciding) panic('The run never saved the phase that decides on reuse');
    const { completionReuse: _unrecorded, ...legacy } = deciding;
    agent.script('reviewer', fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(await reload(legacy));

    expect(status).toBe('halted');
    expect(state.completionReuseAuthorized).toBeUndefined();
    expect(state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 1 });
  });

  it('runs an ordinary final check on a reloaded legacy run whose completion evidence recorded no review scope', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const store = new InMemoryRunStore();
    const { agent, run, reload, start } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
      store,
    });
    scriptReusedRun(agent);
    await run(start);
    const deciding = store.saved.find((saved) => saved.phase === 'checkingReuse');
    if (!deciding?.completionReuse) panic('The run never saved evidence before deciding on reuse');
    const { scope: _unrecorded, ...evidenceWithoutScope } = deciding.completionReuse;
    const legacy = { ...deciding, completionReuse: evidenceWithoutScope } as RunState;
    agent.script('reviewer', fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(await reload(legacy));

    expect(status).toBe('halted');
    expect(state.completionReuseAuthorized).toBeUndefined();
    expect(state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 1 });
  });

  it.each(['describing', 'merging', 'awaitingMerge'] as const)(
    'runs a final check before %s when authorized legacy evidence has no review scope',
    async (phase) => {
      const verifyCommand = `npm run ${faker.word.verb()}`;
      const staleDescription = faker.lorem.paragraph();
      const store = new InMemoryRunStore();
      const { agent, run, reload, start } = await setup({
        settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
        store,
      });
      scriptReusedRun(agent);
      const halted = await run(start);
      const saved =
        phase === 'awaitingMerge'
          ? halted.state
          : store.saved.find((state) => state.phase === phase && state.completionReuseAuthorized);
      if (!saved?.completionReuse) panic(`The run never saved evidence before ${phase}`);
      const { scope: _missing, ...legacyEvidence } = saved.completionReuse;
      const legacy = {
        ...saved,
        completionReuse: legacyEvidence,
        prDescription: staleDescription,
      } as RunState;
      agent.script('reviewer', fulfillment());
      agent.script('describer', aDescription());

      const { status, state } = await run(await reload(legacy));

      expect(status).toBe('halted');
      expect(state.phase).toBe('awaitingMerge');
      expect(state.completionReuseAuthorized).toBeUndefined();
      expect(state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 1 });
      expect(state.prDescription).not.toBe(staleDescription);
      expect(agent.commands).toEqual([verifyCommand, verifyCommand]);
    },
  );

  it('checks the whole run when the combined review approves code without a fulfillment verdict', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, start } = await setup({ settings: runSettings({ verifyCommand }) });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', { output: { approved: true, feedback: '' } }, fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.slices[0]).toMatchObject({ status: 'approved', reviewCycles: 0 });
    expect(state.completionReuse).toBeUndefined();
    expect(state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 1 });
    expect(agent.commands).toEqual([verifyCommand, verifyCommand]);
  });

  it.each(['describing', 'merging'] as const)(
    'finishes a reloaded run saved before %s on its reused completion without repeating any work',
    async (phase) => {
      const verifyCommand = `npm run ${faker.word.verb()}`;
      const store = new InMemoryRunStore();
      const { agent, run, reload, start } = await setup({
        settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
        store,
      });
      scriptReusedRun(agent);
      await run(start);
      const saved = store.saved.find((s) => s.phase === phase && s.completionReuseAuthorized);
      if (!saved) panic(`The run never saved its reused completion before ${phase}`);
      agent.script('describer', aDescription());
      const callsBefore = agent.calls.length;
      const describersNeeded = phase === 'describing' ? 1 : 0;

      const { status, state } = await run(await reload(saved));

      expect(status).toBe('halted');
      expect(state).toMatchObject({ phase: 'awaitingMerge', completionReuseAuthorized: true });
      expect(state.finalCheck).toBeUndefined();
      expect(state.completionReuse).toEqual(saved.completionReuse);
      expect(agent.commands).toEqual([verifyCommand]);
      expect(agent.calls.length - callsBefore).toBe(describersNeeded);
    },
  );

  it('runs an ordinary final check for a reloaded run whose evidence breaks before it merges', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const store = new InMemoryRunStore();
    const { agent, run, reload, start, sandboxPath } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
      store,
    });
    scriptReusedRun(agent);
    await run(start);
    const merging = store.saved.find((s) => s.phase === 'merging' && s.completionReuseAuthorized);
    if (!merging) panic('The run never saved its reused completion before merging');
    await writeFile(path.join(sandboxPath, `${faker.string.uuid()}.txt`), faker.lorem.sentence());
    agent.script('reviewer', fulfillment());
    agent.script('describer', aDescription());

    const { state } = await run(await reload(merging));

    expect(state.completionReuseAuthorized).toBeUndefined();
    expect(state.finalCheck).toMatchObject({ round: 1 });
    expect(state.slices).toHaveLength(1);
  });

  it('runs the final check when the verify command changed after the review', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const changedCommand = `${verifyCommand} ${faker.word.noun()}`;
    const { agent, run, runUnder, reload, start } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
    });
    scriptReusedRun(agent);
    const halted = await run(start);
    agent.script('reviewer', fulfillment());
    agent.script('describer', aDescription());

    const resumed = await runUnder(
      runSettings({ verifyCommand: changedCommand, mergeMode: 'manual' }),
      await reload(halted.state),
    );

    expect(resumed.state.completionReuseAuthorized).toBeUndefined();
    expect(resumed.state.finalCheck).toMatchObject({ verified: true, round: 1 });
    expect(agent.commands).toEqual([verifyCommand, changedCommand]);
  });

  it('runs the final check when the run branch gained a commit after the review', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, reload, start, worktreePath } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
    });
    scriptReusedRun(agent);
    const halted = await run(start);
    await writeFile(path.join(worktreePath, `${faker.string.uuid()}.txt`), faker.lorem.sentence());
    const host = simpleGit({ baseDir: worktreePath });
    await host.add('.');
    await host.commit(faker.lorem.sentence());
    agent.script('reviewer', fulfillment());
    agent.script('describer', aDescription());

    const resumed = await run(await reload(halted.state));

    expect(resumed.state.completionReuseAuthorized).toBeUndefined();
    expect(resumed.state.finalCheck).toMatchObject({ round: 1 });
  });

  it('runs the final check when the host work tree is dirty', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, reload, start, worktreePath } = await setup({
      settings: runSettings({ verifyCommand, mergeMode: 'manual' }),
    });
    scriptReusedRun(agent);
    const halted = await run(start);
    await writeFile(path.join(worktreePath, `${faker.string.uuid()}.txt`), faker.lorem.sentence());
    agent.script('reviewer', fulfillment());
    agent.script('describer', aDescription());

    const resumed = await run(await reload(halted.state));

    expect(resumed.state.completionReuseAuthorized).toBeUndefined();
    expect(resumed.state.finalCheck).toMatchObject({ round: 1 });
  });

  it('runs the final check when the combined review approved the slice but left a gap', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { agent, run, start } = await setup({ settings: runSettings({ verifyCommand }) });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
    agent.script('reviewer', approvalLeavingGaps(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.completionReuseAuthorized).toBeUndefined();
    expect(state.finalCheck).toMatchObject({ fulfilled: true, round: 1 });
    expect(agent.commands).toEqual([verifyCommand, verifyCommand]);
    expect(reviewsAfterDesign(agent)).toHaveLength(2);
  });

  it('reuses the review of a slice whose verification failed once and then passed, on the passing verification', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const exitCodes = [1, 0];
    const { agent, run, start } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => ({ exitCode: exitCodes.shift() ?? 0, output: faker.lorem.sentence() }),
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script(
      'implementer',
      { files: { 'a.txt': faker.lorem.sentence() } },
      { files: { 'b.txt': faker.lorem.sentence() } },
    );
    agent.script('reviewer', approval());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(agent.commands).toEqual([verifyCommand, verifyCommand]);
    expect(reviewsAfterDesign(agent)).toHaveLength(1);
    expect(state.completionReuseAuthorized).toBe(true);
    expect(state.completionReuse?.verification?.command).toBe(verifyCommand);
  });

  it('runs the final check for a run of several slices, recording no completion evidence', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const slices = [
      aPlannedSlice({ description: implementingPlanSteps(1) }),
      aPlannedSlice({ description: implementingPlanSteps(1) }),
    ];
    const { agent, run, start } = await setup({ settings: runSettings({ verifyCommand }) });
    scriptPlanning(agent, slices);
    scriptDelivery(agent, slices);

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.completionReuse).toBeUndefined();
    expect(state.completionReuseAuthorized).toBeUndefined();
    expect(state.finalCheck).toMatchObject({ fulfilled: true, round: 1 });
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
    agent.script('reviewer', approvalLeavingGaps(), unfulfilled(gap), approval(), fulfillment());
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
    agent.script('reviewer', approvalLeavingGaps(), fulfillment(), approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(agent.commands).toEqual([verifyCommand, verifyCommand, verifyCommand, verifyCommand]);
    expect(state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 2 });
    expect(agent.calls.filter((call) => call.role === 'implementer')[1].prompt).toContain(failure);
  });

  it('leaves a stuck slice its rejected review and current verification failure, through a reload', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const feedback = faker.lorem.sentence();
    const lastOutput = failureOutput();
    const results: ExecResult[] = [
      { exitCode: 0, output: faker.lorem.sentence() },
      { exitCode: 1, output: failureOutput() },
      { exitCode: 1, output: failureOutput() },
      { exitCode: 1, output: lastOutput },
    ];
    const { agent, run, start, reload } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => results.shift() ?? { exitCode: 0, output: '' },
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script(
      'implementer',
      ...Array.from({ length: 4 }, () => ({
        files: { [`${faker.string.alpha(8)}.txt`]: faker.lorem.sentence() },
      })),
    );
    agent.script('reviewer', rejection(feedback));
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('stuck');
    const sliceId = state.slices[0].id;
    const diagnostics = runDiagnostics(await reload(state));
    expect(diagnostics.unresolvedReviews).toEqual([
      { sliceId, feedback, at: state.slices[0].rejectedReview?.at },
    ]);
    expect(diagnostics.lastVerificationFailure).toMatchObject({
      scope: { kind: 'slice', sliceId },
      command: verifyCommand,
      output: { captured: true, tail: lastOutput },
      current: true,
    });
    expect(diagnostics.lastVerificationFailure?.at).toBeGreaterThan(
      diagnostics.unresolvedReviews[0].at,
    );
  });

  it('resolves a rejected review the next review approves, keeping the failure before it as history', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const output = failureOutput();
    const results: ExecResult[] = [
      { exitCode: 0, output: faker.lorem.sentence() },
      { exitCode: 1, output },
      { exitCode: 0, output: faker.lorem.sentence() },
    ];
    const { agent, run, start } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => results.shift() ?? { exitCode: 0, output: '' },
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script(
      'implementer',
      ...Array.from({ length: 3 }, () => ({
        files: { [`${faker.string.alpha(8)}.txt`]: faker.lorem.sentence() },
      })),
    );
    agent.script('reviewer', rejection(), approval());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    const diagnostics = runDiagnostics(state);
    expect(diagnostics.unresolvedReviews).toEqual([]);
    expect(diagnostics.lastVerificationFailure).toMatchObject({
      output: { tail: output },
      current: false,
    });
  });

  it('keeps the latest repair failure and the final check failure before it once the repaired run passes, through a reload', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const finalOutput = failureOutput();
    const repairOutput = failureOutput();
    const results: ExecResult[] = [
      { exitCode: 0, output: faker.lorem.sentence() },
      { exitCode: 1, output: finalOutput },
      { exitCode: 1, output: repairOutput },
      { exitCode: 0, output: faker.lorem.sentence() },
      { exitCode: 0, output: faker.lorem.sentence() },
    ];
    const { agent, run, start, reload } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => results.shift() ?? { exitCode: 1, output: '' },
    });
    scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    agent.script(
      'implementer',
      ...Array.from({ length: 3 }, () => ({
        files: { [`${faker.string.alpha(8)}.txt`]: faker.lorem.sentence() },
      })),
    );
    agent.script('reviewer', approvalLeavingGaps(), fulfillment(), approval(), fulfillment());
    agent.script('describer', aDescription());

    const { status, state } = await run(start);

    expect(status).toBe('done');
    const reloaded = await reload(state);
    expect(runDiagnostics(reloaded)).toEqual({
      unresolvedReviews: [],
      outstandingGaps: [],
      lastVerificationFailure: expect.objectContaining({
        scope: { kind: 'slice', sliceId: state.slices[1].id },
        output: { captured: true, tail: repairOutput, truncated: false },
        current: false,
      }),
    });
    expect(reloaded.failedFinalVerification).toMatchObject({
      round: 1,
      output: { captured: true, tail: finalOutput },
      passedSince: true,
    });
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
    agent.script('reviewer', approvalLeavingGaps(), unfulfilled(gap), approval(), fulfillment());
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
    const events = new RecordingEventSink();
    const dependencies = {
      ports: { agent, workspace },
      store,
      events,
      clock: new SteppingClock(),
      settings: input.settings,
    };
    const start = startRun({ runId: id, baseBranch: 'main', request: faker.lorem.paragraph() });
    const invoke = (state: RunState) => runEngine(runFlow, state, dependencies);
    const runUnder = async (settings: RunSettings, state: RunState) =>
      (await runEngine(runFlow, state, { ...dependencies, settings })).unwrap();
    const serialized = new LocalRunStore(await tempDirectory());
    const reload = async (state: RunState) => {
      (await serialized.save(state)).unwrap();
      const loaded = (await serialized.load(state.runId)).unwrap();
      if (!loaded) panic('The saved run is missing');
      return loaded;
    };
    const run = async (state: RunState) => (await invoke(state)).unwrap();
    const runBranchHistory = () =>
      git.raw(['log', '--reverse', '--format=%s', '--patch', `main..${runBranch}`]);
    return {
      agent,
      events,
      invoke,
      run,
      runUnder,
      reload,
      start,
      store,
      git,
      workspace,
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

/** Scripts a single-slice run whose one combined review lets it finish on reused evidence. */
function scriptReusedRun(agent: FakeAgentSession) {
  scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
  agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
  agent.script('reviewer', approval());
  agent.script('describer', aDescription());
}

/** The reviewer's calls once the design review that every planned run starts with is done. */
function reviewsAfterDesign(agent: FakeAgentSession) {
  return agent.calls.filter((call) => call.role === 'reviewer').slice(1);
}

function malformedVerdict() {
  return { output: { verdict: faker.lorem.word() } };
}
