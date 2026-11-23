import { faker } from '@faker-js/faker';
import { Panic, Result } from 'better-result';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  aDescription,
  approval,
  designApproval,
  designFindings,
  designRevision,
  fulfillment,
} from '../../tests/support/agent-scripts.js';
import {
  aDesignFinding,
  aDisposition,
  aFirstDesignReview,
  anApprovedDesignReview,
  aPlannedSlice,
  aRevisedDesignReview,
  aRevisionAwaitingReReview,
  aRunState,
  aSlice,
  designDocs,
  implementingPlanSteps,
  planWithSteps,
  runSettings,
} from '../../tests/support/builders.js';
import { InMemoryRunStore } from '../../tests/support/fakes.js';
import {
  malformedVerdict,
  scriptDelivery,
  scriptDesign,
  setupRunFlow,
} from '../../tests/support/run-flow-setup.js';
import { AgentRunFailed, RunStateConflict } from '../domain/errors.js';
import { type RunState } from '../domain/run-state.js';
import type { RunStore } from '../ports/run-store.js';

describe('runFlow design review', () => {
  it('slices the design the first review approves without asking the planner to revise it', async () => {
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
      const { agent, run, start, store, runBranchHistory } = await setupRunFlow({
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start, store } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings({ maxStepRetries }) });
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
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ maxStepRetries: 0 }),
    });
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
    const { agent, run, start } = await setupRunFlow({
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
      const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start, store } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ maxStepRetries: 1 }),
    });
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
    const { agent, run, start } = await setupRunFlow({
      settings: runSettings({ maxStepRetries: 0 }),
    });
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
    const { agent, invoke, run, start } = await setupRunFlow({ settings: runSettings(), store });
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
      const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
      const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
      const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
      const saved = aRunState({ runId: start.runId, phase });

      const { status, state } = await run(saved);

      expect(status).toBe(phase);
      expect(state).toEqual({ ...saved, blockedReason: undefined });
      expect(agent.calls).toHaveLength(0);
    },
  );
});
