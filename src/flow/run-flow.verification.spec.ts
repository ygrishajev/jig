import { faker } from '@faker-js/faker';
import { panic } from 'better-result';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import {
  aDescription,
  approval,
  approvalLeavingGaps,
  fulfillment,
  rejection,
  scriptPlanning,
  unfulfilled,
} from '../../tests/support/agent-scripts.js';
import {
  aCommit,
  aPlannedSlice,
  aRunStateIn,
  aSlice,
  designDocs,
  implementingPlanSteps,
  runSettings,
} from '../../tests/support/builders.js';
import { InMemoryRunStore } from '../../tests/support/fakes.js';
import {
  reviewsAfterDesign,
  scriptDelivery,
  scriptReusedRun,
  setupRunFlow,
} from '../../tests/support/run-flow-setup.js';
import { enterPhase, type RunState } from '../domain/run-state.js';
import type { ExecResult } from '../ports/agent-session.js';

describe('runFlow verification', () => {
  it('verifies a slice before the reviewer sees it, and finishes on that one verification and one review', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const reviewerCallsWhenCommandRan: number[] = [];
    const { agent, run, start } = await setupRunFlow({
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
    const { agent, run, start } = await setupRunFlow({
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
    const { agent, run, start } = await setupRunFlow({
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
    const { agent, run } = await setupRunFlow({
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
    const { agent, run, start, git } = await setupRunFlow({
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings({ verifyCommand }) });
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
    const { agent, run, start } = await setupRunFlow({
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
    const { agent, run, start, sandboxPath, events } = await setupRunFlow({
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
    const { agent, run, start, sandboxPath } = await setupRunFlow({
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
    const { agent, run, start, sandboxPath, git } = await setupRunFlow({
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
    const { agent, run, reload, start } = await setupRunFlow({
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
    const { agent, run, reload, start, git, runBranch } = await setupRunFlow({
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
      const { agent, run, reload, start } = await setupRunFlow({
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
      const { agent, run, reload, start } = await setupRunFlow({
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
    const { agent, run, reload, start } = await setupRunFlow({
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
    const { agent, run, reload, start } = await setupRunFlow({
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
      const { agent, run, reload, start } = await setupRunFlow({
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings({ verifyCommand }) });
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
      const { agent, run, reload, start } = await setupRunFlow({
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
    const { agent, run, reload, start, sandboxPath } = await setupRunFlow({
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
    const { agent, run, runUnder, reload, start } = await setupRunFlow({
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
    const { agent, run, reload, start, worktreePath } = await setupRunFlow({
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
    const { agent, run, reload, start, worktreePath } = await setupRunFlow({
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings({ verifyCommand }) });
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
    const { agent, run, start } = await setupRunFlow({
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
    const { agent, run, start } = await setupRunFlow({ settings: runSettings({ verifyCommand }) });
    scriptPlanning(agent, slices);
    scriptDelivery(agent, slices);

    const { status, state } = await run(start);

    expect(status).toBe('done');
    expect(state.completionReuse).toBeUndefined();
    expect(state.completionReuseAuthorized).toBeUndefined();
    expect(state.finalCheck).toMatchObject({ fulfilled: true, round: 1 });
  });
});
