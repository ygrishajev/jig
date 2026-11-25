import { faker } from '@faker-js/faker';
import { Panic, panic } from 'better-result';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
  scriptDelivery,
  scriptPlanning,
  unfulfilled,
} from '../../tests/support/agent-scripts.js';
import {
  aContext,
  aDesignFinding,
  aDisposition,
  aFeaturePlan,
  aPlannedSlice,
  aRunState,
  aRunStateIn,
  aSlice,
  designDocs,
  implementingPlanSteps,
  planWithSteps,
  runId,
  runSettings,
} from '../../tests/support/builders.js';
import { FakeWorkspace } from '../../tests/support/fake-workspace.js';
import {
  FakeAgentSession,
  InMemoryRunStore,
  RecordingEventSink,
  SteppingClock,
} from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import type { AgentRole } from '../domain/agent-role.js';
import { enterPhase, type RunPhase, type RunState, startRun } from '../domain/run-state.js';
import {
  EMPTY_ATTEMPT_CAP,
  HOOK_FAILURE_CAP,
  RULE_FIX_CAP,
  type RunSettings,
  VERIFICATION_FAILURE_CAP,
} from '../domain/settings.js';
import type { Slice } from '../domain/slice.js';
import { finalStatus } from '../flow/define-flow.js';
import { runEngine } from '../flow/engine.js';
import { AgentRunFailed, type ExecResult } from '../ports/agent-session.js';
import { runFlow } from './run-flow.js';

describe('runFlow', () => {
  it('takes a request from planning through every slice and the final check to a merge', async () => {
    const slices = [aSliceOfStepOne(), aSliceOfStepOne()];
    const { agent, run, start, workspace, phases } = await setup();
    scriptPlanning(agent, slices);
    scriptDelivery(agent, slices);

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(phases()).toEqual([
      'planning',
      'designing',
      'reviewingDesign',
      'slicing',
      'gate',
      'slices',
      'checkingReuse',
      'finalCheck',
      'describing',
      'merging',
      'done',
    ]);
    expect(state.slices.map((slice) => slice.status)).toEqual(['approved', 'approved']);
    expect(state.finalCheck).toMatchObject({ verified: true, fulfilled: true, round: 1 });
    expect(workspace.history.map(({ message }) => message)).toEqual(
      slices.map((slice) => slice.title),
    );
    expect(workspace.merged).toBe(true);
  });

  it('reads a run in the completed phase as finished as completed', () => {
    expect(finalStatus(runFlow, aRunState({ phase: 'completed' }))).toBe('completed');
  });

  it('finishes from saved state after an interruption with the commits an uninterrupted run makes', async () => {
    const slices = [aSliceOfStepOne(), aSliceOfStepOne()];
    const work = slices.map(() => someWork());
    const uninterrupted = await setup();
    scriptPlanning(uninterrupted.agent, slices);
    uninterrupted.agent.script('implementer', ...work);
    uninterrupted.agent.script('reviewer', approval(), approval(), fulfillment());
    uninterrupted.agent.script('describer', aDescription());
    await uninterrupted.run(uninterrupted.start);
    const { agent, run, start, savedRun, workspace } = await setup();
    scriptPlanning(agent, slices);
    agent.script('implementer', ...work);
    agent.script('reviewer', approval(), { crash: new Error(faker.lorem.sentence()) });

    await expect(run(start)).rejects.toThrow(Panic);
    const saved = await savedRun();
    agent.script('reviewer', approval(), fulfillment());
    agent.script('describer', aDescription());
    const finished = await run(saved);

    expect(saved.slices.map((slice) => slice.status)).toEqual(['approved', 'in_review']);
    expect(finished.status).toBe('done');
    expect(workspace.history).toEqual(uninterrupted.workspace.history);
    expect(workspace.history).toHaveLength(slices.length);
  });

  describe('designing', () => {
    it('slices the design the first review approves without asking the planner to revise it', async () => {
      const slice = aSliceOfStepOne();
      const { agent, run, start, callsOf } = await setup();
      const docs = scriptDesign(agent);
      agent.script('reviewer', designApproval());
      agent.script('planner', { output: [slice] });
      scriptDelivery(agent, [slice]);

      const { state } = await run(start);

      expect(state.docs).toEqual(docs);
      expect(state.slices.map(({ id }) => id)).toEqual([slice.id]);
      expect(callsOf('planner')).toHaveLength(4);
    });

    it('sends the findings to the planner and slices the revised plan the re-review approves', async () => {
      const finding = aDesignFinding();
      const revised = designDocs({ plan: planWithSteps(1, 2) });
      const slices = [1, 2].map((step) =>
        aPlannedSlice({ description: implementingPlanSteps(step) }),
      );
      const { agent, run, start, callsOf } = await setup();
      const reviewed = scriptDesign(agent);
      agent.script('reviewer', designFindings(finding), designApproval());
      agent.script('planner', designRevision(revised, [aDisposition(finding)]), {
        output: slices,
      });
      scriptDelivery(agent, slices);

      const { status, state } = await run(start);

      expect(status).toBe('done');
      expect(state.docs).toEqual(revised);
      const [revision, slicing] = callsOf('planner').slice(3);
      expect(revision.prompt).toContain(finding.failureScenario);
      expect(slicing.prompt).toContain(revised.plan);
      expect(slicing.prompt).not.toContain(reviewed.plan);
    });

    it('blocks before slicing on a finding the re-review still raises, and stays blocked on resume without asking an agent', async () => {
      const finding = aDesignFinding();
      const { agent, run, start, callsOf } = await setup();
      scriptDesign(agent);
      agent.script('reviewer', designFindings(finding), designFindings(finding));
      agent.script('planner', designRevision(designDocs(), [aDisposition(finding)]));

      const blocked = await run(start);
      const callsWhenBlocked = agent.calls.length;
      const resumed = await run(blocked.state);

      for (const { status, state } of [blocked, resumed]) {
        expect(status).toBe('blocked');
        expect(state.phase).toBe('resolvingDesign');
        expect(state.blockedReason).toContain(finding.id);
      }
      expect(agent.calls).toHaveLength(callsWhenBlocked);
      expect(callsOf('implementer')).toHaveLength(0);
    });

    it('resumes an interrupted re-review without granting the planner another revision', async () => {
      const finding = aDesignFinding();
      const revised = designDocs();
      const slice = aSliceOfStepOne();
      const { agent, run, start, savedRun, callsOf } = await setup();
      scriptDesign(agent);
      agent.script('reviewer', designFindings(finding), {
        crash: new Error(faker.lorem.sentence()),
      });
      agent.script('planner', designRevision(revised, [aDisposition(finding)]));

      await expect(run(start)).rejects.toThrow(Panic);
      const saved = await savedRun();
      agent.script('reviewer', designApproval());
      agent.script('planner', { output: [slice] });
      scriptDelivery(agent, [slice]);
      const { status, state } = await run(saved);

      expect(saved).toMatchObject({ phase: 'reviewingDesign', docs: revised });
      expect(status).toBe('done');
      expect(state.designReview?.reviews).toHaveLength(2);
      expect(callsOf('planner')).toHaveLength(5);
    });

    it('asks the planner again on resume for a revision whose call failed', async () => {
      const finding = aDesignFinding();
      const revised = designDocs();
      const slice = aSliceOfStepOne();
      const { agent, run, start } = await setup({ settings: { maxStepRetries: 0 } });
      scriptDesign(agent);
      agent.script('reviewer', designFindings(finding));
      agent.script('planner', { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) });

      const blocked = await run(start);
      agent.script('planner', designRevision(revised, [aDisposition(finding)]), {
        output: [slice],
      });
      agent.script('reviewer', designApproval());
      scriptDelivery(agent, [slice]);
      const resumed = await run(blocked.state);

      expect(blocked).toMatchObject({ status: 'blocked', state: { phase: 'revisingDesign' } });
      expect(resumed).toMatchObject({ status: 'done', state: { docs: revised } });
    });

    it('stops for a person after planning when the design gate is a checkpoint, then continues on resume', async () => {
      const slice = aSliceOfStepOne();
      const { agent, run, start, callsOf } = await setup({
        settings: { designGate: 'checkpoint' },
      });
      scriptPlanning(agent, [slice]);

      const paused = await run(start);

      expect(paused).toMatchObject({ status: 'halted', state: { phase: 'paused' } });
      expect(callsOf('implementer')).toHaveLength(0);
      scriptDelivery(agent, [slice]);
      expect((await run(paused.state)).status).toBe('done');
    });
  });

  describe('delivering a slice', () => {
    it('verifies it before its one review, and finishes on them without a final check', async () => {
      const verifyCommand = `npm run ${faker.word.verb()}`;
      const reviewsWhenCommandRan: number[] = [];
      const { agent, run, callsOf, phases } = await setup({
        settings: { verifyCommand },
        exec: (): ExecResult => {
          reviewsWhenCommandRan.push(callsOf('reviewer').length);
          return { exitCode: 0, output: faker.lorem.sentence() };
        },
      });
      agent.script('implementer', someWork());
      agent.script('reviewer', approval());
      agent.script('describer', aDescription());

      const { status, state } = await run(aRunStateIn('slices', { slices: [aSlice()] }));

      expect(status).toBe('done');
      expect(reviewsWhenCommandRan).toEqual([0]);
      expect(callsOf('reviewer')).toHaveLength(1);
      expect(state.completionReuseAuthorized).toBe(true);
      expect(phases()).toEqual(['checkingReuse', 'describing', 'merging', 'done']);
    });

    it('verifies a resumed one the reviewer approved before it counts as approved', async () => {
      const verifyCommand = `npm run ${faker.word.verb()}`;
      const { agent, run, callsOf } = await setup({ settings: { verifyCommand } });
      agent.script('reviewer', approval(), approval());
      agent.script('describer', aDescription());

      const { status, state } = await run(
        aRunStateIn('slices', { slices: [aSlice({ status: 'in_review' })] }),
      );

      expect(status).toBe('done');
      expect(agent.commands).toEqual([verifyCommand]);
      expect(callsOf('reviewer')).toHaveLength(2);
      expect(state.slices[0]).toMatchObject({
        status: 'approved',
        verification: { command: verifyCommand },
      });
    });

    describe.each([
      ['hookFailures', HOOK_FAILURE_CAP],
      ['verificationFailures', VERIFICATION_FAILURE_CAP],
      ['emptyAttempts', EMPTY_ATTEMPT_CAP],
      ['ruleFixCycles', RULE_FIX_CAP],
      ['reviewCycles', 3],
    ] as const)('with an attempt that spends %s', (counter, cap) => {
      it('sends it back with the feedback while the allowance lasts', async () => {
        const { agent, run, callsOf, failAttempt } = await setup({
          settings: { verifyCommand: `npm run ${faker.word.verb()}`, reviewCycleCap: 3 },
        });
        failAttempt[counter]();
        agent.script('implementer', someWork());
        agent.script('reviewer', approval());
        agent.script('describer', aDescription());

        const { status, state } = await run(aRunHavingSpent(counter, cap - 2));

        expect(status).toBe('done');
        expect(state.slices[0]).toMatchObject({ status: 'approved', [counter]: cap - 1 });
        const [, retry] = callsOf('implementer');
        expect(retry.prompt).toContain(state.slices[0].feedbackHistory.at(-1));
      });

      it('leaves it stuck once the allowance is spent, describing the run unmerged and unchecked', async () => {
        const { agent, run, phases, workspace, failAttempt } = await setup({
          settings: { verifyCommand: `npm run ${faker.word.verb()}`, reviewCycleCap: 3 },
        });
        failAttempt[counter]();
        agent.script('describer', aDescription());

        const { status, state } = await run(aRunHavingSpent(counter, cap - 1));

        expect(status).toBe('stuck');
        expect(state.slices[0]).toMatchObject({ status: 'stuck', [counter]: cap });
        expect(phases()).toEqual(['describing', 'stuck']);
        expect(state.prDescription).toContain(state.slices[0].lastFeedback?.split('\n')[0]);
        expect(workspace.mergeAttempts).toBe(0);
      });
    });
  });

  describe('checking the whole run', () => {
    it('gives a failed check one repair and merges when the repair fulfils the request', async () => {
      const gap = faker.lorem.sentence();
      const { agent, run, callsOf, workspace } = await setup();
      agent.script('implementer', someWork(), someWork());
      agent.script('reviewer', approval(), unfulfilled(gap), approval(), fulfillment());
      agent.script('describer', aDescription());

      const { status, state } = await run(aRunStateIn('slices', { slices: [aSlice()] }));

      expect(status).toBe('done');
      expect(state.finalCheck).toMatchObject({ fulfilled: true, round: 2 });
      expect(state.slices.map((slice) => slice.status)).toEqual(['approved', 'approved']);
      expect(callsOf('implementer')[1].prompt).toContain(gap);
      expect(workspace.merged).toBe(true);
    });

    it('describes the run and stops for a person when the repaired run still fails it', async () => {
      const { agent, run, phases, workspace } = await setup();
      agent.script('implementer', someWork(), someWork());
      agent.script(
        'reviewer',
        approval(),
        unfulfilled(faker.lorem.sentence()),
        approval(),
        unfulfilled(faker.lorem.sentence()),
      );
      agent.script('describer', aDescription());

      const { status, state } = await run(aRunStateIn('slices', { slices: [aSlice()] }));

      expect(status).toBe('stuck');
      expect(state.finalCheck).toMatchObject({ fulfilled: false, round: 2 });
      expect(phases().slice(-2)).toEqual(['describing', 'stuck']);
      expect(workspace.merged).toBe(false);
    });

    it('resumes from the saved repair and appends no second one when the check fails again', async () => {
      const { agent, run, savedRun } = await setup();
      agent.script('implementer', someWork(), { crash: new Error(faker.lorem.sentence()) });
      agent.script('reviewer', approval(), unfulfilled(faker.lorem.sentence()));

      await expect(run(aRunStateIn('slices', { slices: [aSlice()] }))).rejects.toThrow(Panic);
      const saved = await savedRun();
      agent.script('implementer', someWork());
      agent.script('reviewer', approval(), unfulfilled(faker.lorem.sentence()));
      agent.script('describer', aDescription());
      const { status, state } = await run(saved);

      expect(saved).toMatchObject({ phase: 'slices', finalCheck: { round: 1 } });
      expect(status).toBe('stuck');
      expect(state.slices.map(({ id }) => id)).toEqual(saved.slices.map(({ id }) => id));
    });
  });

  describe('finishing', () => {
    it.each(['auto', 'manual'] as const)(
      'ends a run that skips the merge as completed and unmerged, with %s merges',
      async (mergeMode) => {
        const { agent, run, phases, workspace } = await setup({ settings: { mergeMode } });
        agent.script('implementer', someWork());
        agent.script('reviewer', approval(), fulfillment());
        agent.script('describer', aDescription());

        const { status } = await run(aRunStateIn('slices', { slices: [aSlice()], merge: false }));

        expect(status).toBe('completed');
        expect(phases().slice(-2)).toEqual(['describing', 'completed']);
        expect(workspace.merged).toBe(false);
      },
    );

    it('ends a run that skips the merge as stuck when a slice is', async () => {
      const { agent, run } = await setup();
      agent.script('describer', aDescription());

      const { status } = await run(
        aRunStateIn('slices', { slices: [aSlice({ status: 'stuck' })], merge: false }),
      );

      expect(status).toBe('stuck');
    });

    it('waits for a person to merge when merges are manual, and finishes once they have', async () => {
      const { agent, run, workspace } = await setup({ settings: { mergeMode: 'manual' } });
      agent.script('implementer', someWork());
      agent.script('reviewer', approval(), fulfillment());
      agent.script('describer', aDescription());

      const waiting = await run(aRunStateIn('slices', { slices: [aSlice()] }));
      const stillWaiting = await run(waiting.state);
      workspace.mergeByHand();
      const merged = await run(stillWaiting.state);

      for (const { status, state } of [waiting, stillWaiting]) {
        expect({ status, phase: state.phase }).toEqual({
          status: 'halted',
          phase: 'awaitingMerge',
        });
      }
      expect(merged.status).toBe('done');
    });

    it('blocks instead of merging when the run branch gained a commit nobody approved', async () => {
      const { agent, run, workspace } = await setup();
      const slice = aSlice();
      agent.script('implementer', someWork());
      agent.script('reviewer', approval(), fulfillment());
      agent.script('describer', aDescription());
      const halted = await run(aRunStateIn('slices', { slices: [slice], merge: false }));
      workspace.commitOnHost();

      const { status } = await run({ ...enterPhase(halted.state, 'merging'), merge: true });

      expect(status).toBe('blocked');
      expect(workspace.merged).toBe(false);
    });
  });

  describe('finishing on a reused review', () => {
    it('goes through the final check when the review left a gap', async () => {
      const { agent, run, phases } = await setup({
        settings: { verifyCommand: `npm run ${faker.word.verb()}` },
      });
      agent.script('implementer', someWork());
      agent.script('reviewer', approvalLeavingGaps(), fulfillment());
      agent.script('describer', aDescription());

      const { status, state } = await run(aRunStateIn('slices', { slices: [aSlice()] }));

      expect(status).toBe('done');
      expect(phases()).toContain('finalCheck');
      expect(state.completionReuseAuthorized).toBeUndefined();
    });

    it('resumes a run waiting for its merge on the same review, running nothing again', async () => {
      const { agent, run, reusedRunIn } = await setup({
        settings: { verifyCommand: `npm run ${faker.word.verb()}`, mergeMode: 'manual' },
      });
      const waiting = await reusedRunIn('awaitingMerge');
      const callsBefore = agent.calls.length;

      const { status, state } = await run(waiting);

      expect(status).toBe('halted');
      expect(state).toMatchObject({
        completionReuseAuthorized: true,
        prDescription: waiting.prDescription,
      });
      expect(agent.calls).toHaveLength(callsBefore);
      expect(agent.commands).toHaveLength(1);
    });

    it.each(['describing', 'merging', 'awaitingMerge'] as const)(
      'falls back to the final check and a new description when the work changed by %s',
      async (phase) => {
        const { agent, run, reusedRunIn, sandboxPath, phases } = await setup({
          settings: { verifyCommand: `npm run ${faker.word.verb()}`, mergeMode: 'manual' },
        });
        const saved = await reusedRunIn(phase);
        await writeFile(path.join(sandboxPath, faker.string.uuid()), faker.lorem.sentence());
        agent.script('reviewer', fulfillment());
        agent.script('describer', aDescription());
        const phasesBefore = phases().length;

        const { status, state } = await run(saved);

        expect(status).toBe('halted');
        expect(phases().slice(phasesBefore)).toContain('finalCheck');
        expect(state.completionReuse).toEqual(saved.completionReuse);
        expect(state.completionReuseAuthorized).toBeUndefined();
        expect(state.finalCheck).toMatchObject({ round: 1 });
        expect(state.prDescription).not.toBe(saved.prDescription);
      },
    );

    it('counts an already merged run as done even when its sources have changed', async () => {
      const { agent, run, reusedRunIn, workspace } = await setup({
        settings: { verifyCommand: `npm run ${faker.word.verb()}`, mergeMode: 'manual' },
      });
      const waiting = await reusedRunIn('awaitingMerge');
      workspace.mergeByHand();
      const callsBefore = agent.calls.length;

      const { status } = await run({ ...waiting, request: faker.lorem.paragraph() });

      expect(status).toBe('done');
      expect(agent.calls).toHaveLength(callsBefore);
    });
  });

  async function setup({
    settings = {},
    exec = (): ExecResult => ({ exitCode: 0, output: faker.lorem.sentence() }),
  }: { settings?: Partial<RunSettings>; exec?: () => ExecResult } = {}) {
    const sandboxPath = await tempDirectory();
    const failures: ExecResult[] = [];
    const agent = new FakeAgentSession(sandboxPath, () => failures.shift() ?? exec());
    const workspace = new FakeWorkspace(agent);
    const store = new InMemoryRunStore();
    const events = new RecordingEventSink();
    const dependencies = {
      ports: { agent, workspace },
      store,
      events,
      clock: new SteppingClock(),
      settings: runSettings(settings),
    };
    const start = startRun({
      runId: runId(),
      baseBranch: 'main',
      request: faker.lorem.paragraph(),
    });
    const run = async (state: RunState) => unwrap(await runEngine(runFlow, state, dependencies));
    const phases = () => events.ofType('phaseChanged').map(({ to }) => to);
    const callsOf = (role: AgentRole) => agent.calls.filter((call) => call.role === role);
    const savedRun = async () => store.saved.at(-1) ?? panic('The run was never saved');
    const reusedRunIn = async (phase: RunPhase) => {
      agent.script('implementer', someWork());
      agent.script('reviewer', approval());
      agent.script('describer', aDescription());
      const { state } = await run(aRunStateIn('slices', { slices: [aSlice()] }));
      const saved = store.saved.find(
        (candidate) => candidate.phase === phase && candidate.completionReuseAuthorized,
      );
      return saved ?? panic(`The run stopped in ${state.phase} without reaching ${phase}`);
    };
    const failAttempt = {
      hookFailures: () => {
        workspace.rejectNextCommit(faker.lorem.sentence());
        agent.script('implementer', someWork());
      },
      verificationFailures: () => {
        failures.push({ exitCode: 1, output: faker.lorem.sentence() });
        agent.script('implementer', someWork());
      },
      emptyAttempts: () => agent.script('implementer', { files: {} }),
      ruleFixCycles: () => {
        agent.script('implementer', someWork());
        agent.script('reviewer', ruleFindings());
      },
      reviewCycles: () => {
        agent.script('implementer', someWork());
        agent.script('reviewer', rejection());
      },
    };
    return {
      agent,
      workspace,
      sandboxPath,
      start,
      run,
      phases,
      callsOf,
      savedRun,
      reusedRunIn,
      failAttempt,
    };
  }
});

function aSliceOfStepOne() {
  return aPlannedSlice({ description: implementingPlanSteps(1) });
}

function someWork() {
  return { files: { [`${faker.string.uuid()}.txt`]: faker.lorem.sentence() } };
}

function aRunHavingSpent(counter: keyof Slice, spent: number) {
  return aRunStateIn('slices', { slices: [aSlice({ [counter]: spent })] });
}

/** Scripts the planner's context, feature plan and the design documents it writes. */
function scriptDesign(agent: FakeAgentSession, docs = designDocs()) {
  agent.script('planner', { output: aContext() }, { output: aFeaturePlan() }, { output: docs });
  return docs;
}
