import { faker } from '@faker-js/faker';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { approval } from '../../tests/support/agent-scripts.js';
import { aRunState, aSlice, runId, runSettings } from '../../tests/support/builders.js';
import { type AgentScript, FakeAgentSession } from '../../tests/support/fakes.js';
import { createRunWorktree } from '../../tests/support/run-worktree.js';
import { applyOutcome } from '../domain/apply-outcome.js';
import { SandboxUnavailable } from '../domain/errors.js';
import type { RunSettings } from '../domain/settings.js';
import type { Slice } from '../domain/slice.js';
import type { SliceStep } from '../flow/define-flow.js';
import type { ExecResult } from '../ports/agent-session.js';
import { implementSlice, reviewSlice, verifySlice } from './slice.js';

describe('slice steps', () => {
  it('commits what the implementer changed onto the run branch', async () => {
    const slice = aSlice();
    const { run, git, runBranch } = await setup({
      implementer: [{ files: { 'feature.txt': faker.lorem.sentence() } }],
    });

    const outcome = await run(implementSlice, slice);

    const head = (await git.log([runBranch, '-1'])).latest;
    expect(outcome).toMatchObject({
      type: 'implemented',
      commit: { sha: head?.hash, filesChanged: 1, insertions: 1, deletions: 0 },
    });
    expect(head?.message).toBe(slice.title);
  });

  it("sends the slice back to the implementer with the hooks' output when the repository's commit hooks reject its work", async () => {
    const hookOutput = faker.lorem.words(4);
    const { run, rejectCommitsInSandbox } = await setup({
      implementer: [{ files: { 'feature.txt': faker.lorem.sentence() } }],
    });
    await rejectCommitsInSandbox(hookOutput);

    const outcome = await run(implementSlice, aSlice());

    expect(outcome).toMatchObject({
      type: 'changesRequested',
      feedback: expect.stringContaining(hookOutput),
    });
  });

  it("takes a commit the implementer made itself as the slice's change", async () => {
    const commitMessage = faker.lorem.sentence();
    const { run, git, runBranch } = await setup({
      implementer: [{ files: { 'feature.txt': faker.lorem.sentence() }, commitMessage }],
    });

    const outcome = await run(implementSlice, aSlice());

    const head = (await git.log([runBranch, '-1'])).latest;
    expect(head?.message).toBe(commitMessage);
    expect(outcome).toMatchObject({ type: 'implemented', commit: { sha: head?.hash } });
  });

  it('gives the reviewer every commit since the run branch was cut when reviewing the first slice', async () => {
    const { run, agent, git, runBranch } = await setup({
      implementer: [
        { files: { 'first.txt': faker.lorem.sentence() } },
        { files: { 'second.txt': faker.lorem.sentence() } },
      ],
      reviewer: [approval()],
    });
    const forkPoint = await git.revparse([runBranch]);
    const slice = aSlice();
    await run(implementSlice, slice);
    await run(implementSlice, { ...slice, lastFeedback: faker.lorem.sentence() });

    await run(reviewSlice, { ...slice, status: 'in_review' });

    expect((await git.log([`${forkPoint}..${runBranch}`])).total).toBe(2);
    expect(agent.calls.at(-1)?.prompt).toContain(`${forkPoint}..HEAD`);
  });

  it('starts a slice where the previous slice ended, so a commit left by an interrupted attempt is still reviewed', async () => {
    const { run, agent, git, runBranch, workspace, sandboxPath } = await setup({
      implementer: [{ files: { 'resumed.txt': faker.lorem.sentence() } }],
      reviewer: [approval()],
    });
    await writeFile(path.join(sandboxPath, 'previous.txt'), faker.lorem.sentence());
    (
      await workspace.saveWork(faker.lorem.sentence(), {
        approved: (await workspace.forkPoint()).unwrap(),
      })
    ).unwrap();
    const previous = aSlice({
      order: 0,
      status: 'approved',
      commit: await git.revparse([runBranch]),
    });
    await writeFile(path.join(sandboxPath, 'interrupted.txt'), faker.lorem.sentence());
    (
      await workspace.saveWork(faker.lorem.sentence(), {
        approved: (await workspace.forkPoint()).unwrap(),
      })
    ).unwrap();
    const slice = aSlice({ order: 1 });
    await run(implementSlice, slice, [previous]);

    await run(reviewSlice, { ...slice, status: 'in_review' }, [previous]);

    expect((await git.log([`${previous.commit}..${runBranch}`])).total).toBe(2);
    expect(agent.calls.at(-1)?.prompt).toContain(`${previous.commit}..HEAD`);
  });

  it('sends the slice back to the implementer instead of to review when it changed nothing', async () => {
    const { run } = await setup({ implementer: [{ files: {} }] });

    const outcome = await run(implementSlice, aSlice());

    expect(outcome).toMatchObject({ type: 'changesRequested' });
  });

  it('keeps the feedback the empty attempt was meant to address', async () => {
    const lastFeedback = faker.lorem.sentence();
    const { run } = await setup({ implementer: [{ files: {} }] });

    const outcome = await run(implementSlice, aSlice({ lastFeedback }));

    expect(outcome.type === 'changesRequested' && outcome.feedback).toContain(lastFeedback);
  });

  it('hands the reviewer feedback from the last attempt back to the implementer', async () => {
    const lastFeedback = faker.lorem.sentence();
    const { run, agent } = await setup({ implementer: [{ files: {} }] });

    await run(implementSlice, aSlice({ lastFeedback }));

    expect(agent.calls[0].prompt).toContain(lastFeedback);
  });

  it("approves when the reviewer approves, and requests the reviewer's changes otherwise", async () => {
    const feedback = faker.lorem.sentence();
    const approving = await setup({ reviewer: [{ output: { approved: true, feedback: '' } }] });
    const approved = await approving.run(reviewSlice, aSlice());
    const rejecting = await setup({ reviewer: [{ output: { approved: false, feedback } }] });

    expect(approved).toEqual({ type: 'approved' });
    expect(await rejecting.run(reviewSlice, aSlice())).toEqual({
      type: 'changesRequested',
      feedback,
    });
  });

  it('verifies without running anything when no verify command is configured', async () => {
    const { run, agent } = await setup({ settings: runSettings({ verifyCommand: undefined }) });

    expect(await run(verifySlice, aSlice())).toEqual({ type: 'verified' });
    expect(agent.commands).toEqual([]);
  });

  it('records the verify command it ran when the slice passes', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const output = faker.lorem.sentence();
    const { run } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => ({ exitCode: 0, output }),
    });

    expect(await run(verifySlice, aSlice())).toEqual({ type: 'verified', command: verifyCommand });
  });

  it('clears the verification a slice passed once changes are requested on it', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { run } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => ({ exitCode: 0, output: faker.lorem.sentence() }),
    });
    const slice = aSlice({ status: 'verifying' });
    const verified = await run(verifySlice, slice);
    let state = applyOutcome(aRunState({ slices: [slice] }), verified);

    expect(state.slices[0].verification).toEqual({ command: verifyCommand });

    state = applyOutcome(state, { type: 'changesRequested', feedback: faker.lorem.sentence() });

    expect(state.slices[0].verification).toBeUndefined();
  });

  it('runs the verify command in the sandbox and requests changes with its output when it fails', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const failure = faker.lorem.sentence();
    const { run, agent } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => ({ exitCode: 1, output: failure }),
    });

    const outcome = await run(verifySlice, aSlice());

    expect(agent.commands).toEqual([verifyCommand]);
    expect(outcome).toMatchObject({ type: 'changesRequested' });
    expect(outcome.type === 'changesRequested' && outcome.feedback).toContain(failure);
  });

  it('cuts long verify output short in the feedback', async () => {
    const { run } = await setup({
      settings: runSettings({ verifyCommand: 'npm test' }),
      exec: () => ({ exitCode: 1, output: faker.string.alpha(5000) }),
    });

    const outcome = await run(verifySlice, aSlice());

    expect(outcome.type === 'changesRequested' && outcome.feedback.length).toBeLessThan(600);
  });

  it('passes on a sandbox that cannot run the verify command at all', async () => {
    const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
    const { attempt } = await setup({
      settings: runSettings({ verifyCommand: 'npm test' }),
      exec: () => failure,
    });

    const result = await attempt(verifySlice, aSlice());

    expect(result.isErr() && result.error).toBe(failure);
  });

  async function setup(input: {
    implementer?: AgentScript[];
    reviewer?: AgentScript[];
    settings?: RunSettings;
    exec?: (command: string) => ExecResult | SandboxUnavailable;
  }) {
    const id = runId();
    const created = await createRunWorktree(id);
    const { workspace } = created;
    const agent = new FakeAgentSession(created.sandboxPath, input.exec);
    agent.script('implementer', ...(input.implementer ?? []));
    agent.script('reviewer', ...(input.reviewer ?? []));
    const state = aRunState({ runId: id });
    const attempt = (step: SliceStep, slice: Slice, earlierSlices: Slice[] = []) =>
      step({
        state: { ...state, slices: [...earlierSlices, slice] },
        slice,
        ports: { agent, workspace },
        settings: input.settings ?? runSettings(),
      });
    const run = async (step: SliceStep, slice: Slice, earlierSlices: Slice[] = []) =>
      (await attempt(step, slice, earlierSlices)).unwrap();
    return {
      run,
      attempt,
      agent,
      workspace,
      sandboxPath: created.sandboxPath,
      git: created.git,
      runBranch: created.runBranch,
      rejectCommitsInSandbox: created.rejectCommitsInSandbox,
    };
  }
});
