import { faker } from '@faker-js/faker';
import { Panic } from 'better-result';
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
import { aPlannedSlice, implementingPlanSteps, runSettings } from '../../tests/support/builders.js';
import { reviewsAfterDesign, setupRunFlow } from '../../tests/support/run-flow-setup.js';
import type { ExecResult } from '../ports/agent-session.js';

describe('runFlow final check', () => {
  it('gives a failed final check one repair and merges when the repair fulfils the request', async () => {
    const gap = faker.lorem.sentence();
    const slice = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { agent, run, start, git, runBranch } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start, store, git, runBranch, worktreePath } = await setupRunFlow({
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
    const { agent, run, start, git } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start } = await setupRunFlow({
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
    const { agent, run, start } = await setupRunFlow({
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
    const { agent, run, start, git } = await setupRunFlow({
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
    const { agent, run, start, store, git } = await setupRunFlow({ settings: runSettings() });
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
    const { agent, run, start, store, git } = await setupRunFlow({ settings: runSettings() });
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
});
