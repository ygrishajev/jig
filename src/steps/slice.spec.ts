import { faker } from '@faker-js/faker';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorkspace } from '../adapters/git/git-workspace.js';
import type { RunSettings } from '../domain/settings.js';
import type { Slice } from '../domain/slice.js';
import type { ExecResult } from '../ports/agent-session.js';
import { aRunState, aSlice, runId, runSettings } from '../../tests/support/builders.js';
import { FakeAgentSession, type AgentScript } from '../../tests/support/fakes.js';
import { createRunWorktree, type RunWorktree } from '../../tests/support/run-worktree.js';
import type { SliceStep } from '../flow/define-flow.js';
import { implementSlice, reviewSlice, verifySlice } from './slice.js';

describe('slice steps', () => {
  let worktree: RunWorktree | undefined;

  afterEach(async () => {
    await worktree?.cleanup();
    worktree = undefined;
  });

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
    expect(head?.message).toContain(slice.id);
  });

  it('records the run branch head the slice started from, and keeps it across attempts', async () => {
    const { run, git, runBranch } = await setup({
      implementer: [
        { files: { 'first.txt': faker.lorem.sentence() } },
        { files: { 'second.txt': faker.lorem.sentence() } },
      ],
    });
    const branchHeadBeforeSlice = await git.revparse([runBranch]);
    const slice = aSlice();

    const first = await run(implementSlice, slice);
    const startCommit = first.type === 'implemented' ? first.startCommit : undefined;
    const second = await run(implementSlice, { ...slice, startCommit });

    expect(first).toMatchObject({ type: 'implemented', startCommit: branchHeadBeforeSlice });
    expect(second).toMatchObject({ type: 'implemented', startCommit: branchHeadBeforeSlice });
  });

  it('gives the reviewer every commit since the slice started, not just the latest fix', async () => {
    const { run, agent, git, runBranch } = await setup({
      implementer: [
        { files: { 'first.txt': faker.lorem.sentence() } },
        { files: { 'second.txt': faker.lorem.sentence() } },
      ],
      reviewer: [{ output: { approved: true, feedback: '' } }],
    });
    const slice = aSlice();
    const first = await run(implementSlice, slice);
    const startCommit = first.type === 'implemented' ? first.startCommit : undefined;
    await run(implementSlice, { ...slice, startCommit, lastFeedback: faker.lorem.sentence() });

    await run(reviewSlice, { ...slice, status: 'in_review', startCommit });

    const reviewed = await git.log([`${startCommit}..${runBranch}`]);
    expect(reviewed.total).toBe(2);
    expect(agent.calls.at(-1)?.prompt).toContain(`${startCommit}..HEAD`);
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
    await approving.cleanup();
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

  async function setup(input: {
    implementer?: AgentScript[];
    reviewer?: AgentScript[];
    settings?: RunSettings;
    exec?: (command: string) => ExecResult;
  }) {
    const id = runId();
    const created = await createRunWorktree(id);
    worktree = created;
    const agent = new FakeAgentSession(created.worktreePath, input.exec);
    agent.script('implementer', ...(input.implementer ?? []));
    agent.script('reviewer', ...(input.reviewer ?? []));
    const workspace = new GitWorkspace({
      repoRoot: created.repo.dir,
      worktreePath: created.worktreePath,
      runId: id,
      baseBranch: 'main',
    });
    const state = aRunState({ runId: id });
    const run = (step: SliceStep, slice: Slice) =>
      step({
        state,
        slice,
        ports: { agent, workspace },
        settings: input.settings ?? runSettings(),
      });
    return { run, agent, git: created.git, runBranch: created.runBranch, cleanup: created.cleanup };
  }
});
