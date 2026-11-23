import { faker } from '@faker-js/faker';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { approval, ruleFindings } from '../../tests/support/agent-scripts.js';
import {
  aFinalCheckResult,
  aRunState,
  aSlice,
  designDocs,
  runId,
  runSettings,
  workObservations,
} from '../../tests/support/builders.js';
import { type AgentScript, FakeAgentSession } from '../../tests/support/fakes.js';
import { createRunWorktree } from '../../tests/support/run-worktree.js';
import { GitWorkspace } from '../adapters/git/git-workspace.js';
import { retryResult } from '../adapters/retry.js';
import { applyOutcome, updateCurrentSlice } from '../domain/apply-outcome.js';
import { completionStillReusable, settingsIdentityOf } from '../domain/completion-reuse.js';
import { AgentRunFailed, SandboxUnavailable } from '../domain/errors.js';
import type { Outcome } from '../domain/outcome.js';
import type { RunPhase, RunState } from '../domain/run-state.js';
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

  it('commits what the implementer left uncommitted with the message it replied with', async () => {
    const commitMessage = faker.lorem.sentence();
    const { run, git, runBranch } = await setup({
      implementer: [
        { files: { 'feature.txt': faker.lorem.sentence() }, output: { commitMessage } },
      ],
    });

    await run(implementSlice, aSlice());

    expect((await git.log([runBranch, '-1'])).latest?.message).toBe(commitMessage);
  });

  it('commits with the slice title when the implementer replies without a commit message', async () => {
    const slice = aSlice();
    const { run, git, runBranch } = await setup({
      implementer: [
        { files: { 'feature.txt': faker.lorem.sentence() }, output: { commitMessage: ' ' } },
      ],
    });

    await run(implementSlice, slice);

    expect((await git.log([runBranch, '-1'])).latest?.message).toBe(slice.title);
  });

  it('reports a failed implementer run without committing anything', async () => {
    const failure = new AgentRunFailed({ message: faker.lorem.sentence() });
    const { attempt, git, runBranch } = await setup({ implementer: [{ fail: failure }] });
    const before = await git.revparse([runBranch]);

    const result = await attempt(implementSlice, aSlice());

    expect(result.isErr() && result.error).toBe(failure);
    expect(await git.revparse([runBranch])).toBe(before);
  });

  it("sends the slice back to the implementer with the hooks' output when the repository's commit hooks reject its work", async () => {
    const hookOutput = faker.lorem.words(4);
    const { run, rejectCommitsInSandbox } = await setup({
      implementer: [{ files: { 'feature.txt': faker.lorem.sentence() } }],
    });
    await rejectCommitsInSandbox(hookOutput);

    const outcome = await run(implementSlice, aSlice());

    expect(outcome).toMatchObject({
      type: 'hookRejected',
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

    expect(outcome).toMatchObject({ type: 'nothingChanged' });
  });

  it('keeps the feedback the empty attempt was meant to address', async () => {
    const lastFeedback = faker.lorem.sentence();
    const { run } = await setup({ implementer: [{ files: {} }] });

    const outcome = await run(implementSlice, aSlice({ lastFeedback }));

    expect(outcome.type === 'nothingChanged' && outcome.feedback).toContain(lastFeedback);
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

  it('asks only for rule fixes when the reviewer finds nothing but broken rules', async () => {
    const feedback = faker.lorem.sentence();
    const { run } = await setup({ reviewer: [ruleFindings(feedback)] });

    expect(await run(reviewSlice, aSlice())).toEqual({ type: 'rulesFixRequested', feedback });
  });

  it('judges the whole request within the review of a run whose single slice is its whole work', async () => {
    const request = `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`;
    const docs = designDocs();
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const observed = workObservations();
    const slice = aSlice({
      status: 'in_review',
      verification: { command: verifyCommand, observed },
    });
    const { run, agent, git, runBranch, settings } = await setup({
      reviewer: [{ output: { approved: true, feedback: '', fulfilled: true, gaps: [] } }],
      settings: runSettings({ verifyCommand }),
      state: { phase: 'slices', request, docs },
    });
    const forkPoint = await git.revparse([runBranch]);

    const outcome = await run(reviewSlice, slice);

    const prompt = agent.calls.at(-1)?.prompt ?? '';
    expect(prompt).toContain(request);
    expect(prompt).toContain(docs.plan);
    const head = await git.revparse([runBranch]);
    const completion = outcome.type === 'approved' ? outcome.completion : undefined;
    expect(completion).toEqual({
      verdict: { fulfilled: true, gaps: [] },
      verification: { command: verifyCommand, observed },
      settingsIdentity: settingsIdentityOf(settings),
      checked: { commit: head, tree: await git.revparse([`${runBranch}^{tree}`]) },
      observed: expect.anything(),
      scope: {
        request: digestOf(request),
        plan: digestOf(docs.plan),
        range: { start: forkPoint, end: head },
      },
    });
  });

  it('binds the whole-request evidence to work that can still be reused as the completion check', async () => {
    const { run, workspace, settings, state } = await setup({
      reviewer: [{ output: { approved: true, feedback: '', fulfilled: true, gaps: [] } }],
      settings: runSettings({ verifyCommand: `npm run ${faker.word.verb()}` }),
      state: { phase: 'slices', request: `# ${faker.lorem.sentence()}`, docs: designDocs() },
    });
    const slice = await verifiedSlice(run);

    const outcome = await run(reviewSlice, slice);

    const applied = approvedRun({ ...state, slices: [slice] }, outcome);
    const facts = (await workspace.collectFacts()).unwrap();
    const forkPoint = (await workspace.forkPoint()).unwrap();
    expect(completionStillReusable(applied, facts, settings, forkPoint)).toBe(true);
  });

  it('records verification that no longer matches the reviewed work, so its evidence cannot be reused', async () => {
    const { run, workspace, settings, state, sandboxPath } = await setup({
      reviewer: [{ output: { approved: true, feedback: '', fulfilled: true, gaps: [] } }],
      settings: runSettings({ verifyCommand: `npm run ${faker.word.verb()}` }),
      state: { phase: 'slices', request: `# ${faker.lorem.sentence()}`, docs: designDocs() },
    });
    const slice = await verifiedSlice(run);
    await writeFile(path.join(sandboxPath, 'moved-on.txt'), faker.lorem.sentence());
    (
      await workspace.saveWork(faker.lorem.sentence(), {
        approved: (await workspace.forkPoint()).unwrap(),
      })
    ).unwrap();

    const outcome = await run(reviewSlice, slice);

    const completion = 'completion' in outcome ? outcome.completion : undefined;
    expect(completion?.verification?.observed?.after.host.commit).not.toBe(
      completion?.checked.commit,
    );
    const applied = approvedRun({ ...state, slices: [slice] }, outcome);
    const facts = (await workspace.collectFacts()).unwrap();
    const forkPoint = (await workspace.forkPoint()).unwrap();
    expect(completionStillReusable(applied, facts, settings, forkPoint)).toBe(false);
  });

  it('records a review whose sandbox stood elsewhere than the host, which no later convergence repairs', async () => {
    const { run, workspace, settings, state, git, runBranch, sandboxPath } = await setup({
      reviewer: [{ output: { approved: true, feedback: '', fulfilled: true, gaps: [] } }],
      settings: runSettings({ verifyCommand: `npm run ${faker.word.verb()}` }),
      state: { phase: 'slices', request: `# ${faker.lorem.sentence()}`, docs: designDocs() },
    });
    const slice = await verifiedSlice(run);
    const sandbox = simpleGit({ baseDir: sandboxPath });
    await writeFile(path.join(sandboxPath, 'elsewhere.txt'), faker.lorem.sentence());
    await sandbox.add('-A').commit(faker.lorem.sentence());
    const head = await git.revparse([runBranch]);

    const outcome = await run(reviewSlice, slice);

    const completion = 'completion' in outcome ? outcome.completion : undefined;
    expect(completion?.checked.commit).toBe(head);
    expect(completion?.observed.before.sandbox.commit).not.toBe(head);
    expect(completion?.observed.after.sandbox.commit).not.toBe(head);
    const applied = approvedRun({ ...state, slices: [slice] }, outcome);
    const forkPoint = (await workspace.forkPoint()).unwrap();
    const stillDivergent = (await workspace.collectFacts()).unwrap();
    expect(completionStillReusable(applied, stillDivergent, settings, forkPoint)).toBe(false);
    await sandbox.raw(['reset', '--hard', head]);
    const converged = (await workspace.collectFacts()).unwrap();
    expect(completionStillReusable(applied, converged, settings, forkPoint)).toBe(false);
  });

  it('keeps the request verdict when the review approves the code but not the request', async () => {
    const gap = faker.lorem.sentence();
    const { run } = await setup({
      reviewer: [{ output: { approved: true, feedback: '', fulfilled: false, gaps: [gap] } }],
      state: { phase: 'slices', request: `# ${faker.lorem.sentence()}`, docs: designDocs() },
    });

    const outcome = await run(reviewSlice, aSlice({ status: 'in_review' }));

    expect(outcome).toMatchObject({
      type: 'approved',
      completion: { verdict: { fulfilled: false, gaps: [gap] } },
    });
  });

  it('keeps the request verdict when the review rejects the code', async () => {
    const feedback = faker.lorem.sentence();
    const { run } = await setup({
      reviewer: [{ output: { approved: false, feedback, fulfilled: true, gaps: [] } }],
      state: { phase: 'slices', request: `# ${faker.lorem.sentence()}`, docs: designDocs() },
    });

    const outcome = await run(reviewSlice, aSlice({ status: 'in_review' }));

    expect(outcome).toMatchObject({
      type: 'changesRequested',
      feedback,
      completion: { verdict: { fulfilled: true, gaps: [] } },
    });
  });

  it('records the mutation a reviewer leaves in the sandbox, so its evidence cannot stand', async () => {
    const { run, workspace, settings, state, sandboxPath } = await setup({
      reviewer: [
        {
          files: { [`${faker.lorem.slug()}.txt`]: faker.lorem.sentence() },
          output: { approved: true, feedback: '', fulfilled: true, gaps: [] },
        },
      ],
      state: { phase: 'slices', request: `# ${faker.lorem.sentence()}`, docs: designDocs() },
    });
    const slice = aSlice({ status: 'in_review' });

    const outcome = await run(reviewSlice, slice);

    const completion = 'completion' in outcome ? outcome.completion : undefined;
    expect(completion?.observed.before.sandbox.clean).toBe(true);
    expect(completion?.observed.after.sandbox.clean).toBe(false);
    expect((await simpleGit({ baseDir: sandboxPath }).status()).isClean()).toBe(false);
    const applied = approvedRun({ ...state, slices: [slice] }, outcome);
    const facts = (await workspace.collectFacts()).unwrap();
    const forkPoint = (await workspace.forkPoint()).unwrap();
    expect(completionStillReusable(applied, facts, settings, forkPoint)).toBe(false);
  });

  it('reviews a multi-slice run as an ordinary slice review, without the request', async () => {
    const request = `# ${faker.lorem.sentence()}`;
    const { run, agent, git, runBranch } = await setup({
      reviewer: [approval()],
      state: { phase: 'slices', request, docs: designDocs() },
    });
    const earlier = aSlice({
      order: 0,
      status: 'approved',
      commit: await git.revparse([runBranch]),
    });
    const current = aSlice({ order: 1, status: 'in_review' });

    const outcome = await run(reviewSlice, current, [earlier]);

    const prompt = agent.calls.at(-1)?.prompt ?? '';
    expect(prompt).not.toContain(request);
    expect('completion' in outcome ? outcome.completion : undefined).toBeUndefined();
  });

  it('reviews a run whose final check already ran as an ordinary slice review', async () => {
    const { run, agent, state } = await setup({
      reviewer: [approval()],
      state: {
        phase: 'slices',
        request: `# ${faker.lorem.sentence()}`,
        docs: designDocs(),
        finalCheck: aFinalCheckResult({ round: 1, verified: true, fulfilled: false }),
      },
    });

    const outcome = await run(reviewSlice, aSlice({ status: 'in_review' }));

    expect(agent.calls.at(-1)?.prompt).not.toContain(state.request);
    expect('completion' in outcome ? outcome.completion : undefined).toBeUndefined();
  });

  it('reviews a run the plan never reached as an ordinary slice review', async () => {
    const { run, agent, state } = await setup({ reviewer: [approval()] });

    const outcome = await run(reviewSlice, aSlice({ status: 'in_review' }));

    expect(agent.calls.at(-1)?.prompt).not.toContain(state.request);
    expect('completion' in outcome ? outcome.completion : undefined).toBeUndefined();
  });

  it('records the request verdict of a review without verification, which cannot stand in for the final check', async () => {
    const { run, workspace, settings, state } = await setup({
      reviewer: [{ output: { approved: true, feedback: '', fulfilled: true, gaps: [] } }],
      settings: runSettings({ verifyCommand: undefined }),
      state: { phase: 'slices', request: `# ${faker.lorem.sentence()}`, docs: designDocs() },
    });
    const slice = aSlice({ status: 'in_review', verification: undefined });

    const outcome = await run(reviewSlice, slice);

    expect(outcome).toMatchObject({
      type: 'approved',
      completion: { verification: undefined, verdict: { fulfilled: true, gaps: [] } },
    });
    const applied = approvedRun({ ...state, slices: [slice] }, outcome);
    const facts = (await workspace.collectFacts()).unwrap();
    const forkPoint = (await workspace.forkPoint()).unwrap();
    expect(completionStillReusable(applied, facts, settings, forkPoint)).toBe(false);
  });

  it('records the evidence of a review after an earlier verification attempt failed', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const observed = workObservations();
    const slice = aSlice({
      status: 'in_review',
      verificationFailures: 1,
      verification: { command: verifyCommand, observed },
    });
    const { run } = await setup({
      reviewer: [{ output: { approved: true, feedback: '', fulfilled: true, gaps: [] } }],
      settings: runSettings({ verifyCommand }),
      state: { phase: 'slices', request: `# ${faker.lorem.sentence()}`, docs: designDocs() },
    });

    const outcome = await run(reviewSlice, slice);

    expect(outcome).toMatchObject({
      type: 'approved',
      completion: {
        verification: { command: verifyCommand, observed },
        verdict: { fulfilled: true, gaps: [] },
      },
    });
  });

  it.each([
    ['missing', { approved: true, feedback: '' }],
    ['invalid', { approved: true, feedback: '', fulfilled: 'unknown', gaps: [] }],
  ])(
    'approves code without completion evidence when the request verdict is %s',
    async (_kind, output) => {
      const { run } = await setup({
        reviewer: [{ output }],
        state: { phase: 'slices', request: `# ${faker.lorem.sentence()}`, docs: designDocs() },
      });

      const outcome = await run(reviewSlice, aSlice({ status: 'in_review' }));

      expect(outcome).toEqual({ type: 'approved' });
    },
  );

  it('fails an eligible review that cannot observe the work before it, without asking the reviewer', async () => {
    const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
    const { attempt, agent } = await setup({
      reviewer: [approval()],
      state: { phase: 'slices', request: `# ${faker.lorem.sentence()}`, docs: designDocs() },
    });
    agent.takeSandboxDown(failure);

    const result = await attempt(reviewSlice, aSlice({ status: 'in_review' }));

    expect(result.isErr() && result.error).toBe(failure);
    expect(agent.calls).toHaveLength(0);
  });

  it('fails an eligible review that cannot observe the resulting work after it, recording nothing', async () => {
    const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
    const { attempt, agent } = await setup({
      reviewer: [
        {
          output: { approved: true, feedback: '', fulfilled: true, gaps: [] },
          takesSandboxDown: failure,
        },
      ],
      state: { phase: 'slices', request: `# ${faker.lorem.sentence()}`, docs: designDocs() },
    });

    const result = await attempt(reviewSlice, aSlice({ status: 'in_review' }));

    expect(result.isErr() && result.error).toBe(failure);
    expect(agent.calls).toHaveLength(1);
  });

  it('fails a verification that cannot observe the work it is about to run on', async () => {
    const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
    const { attempt, agent } = await setup({
      settings: runSettings({ verifyCommand: `npm run ${faker.word.verb()}` }),
    });
    agent.takeSandboxDown(failure);

    const result = await attempt(verifySlice, aSlice({ status: 'verifying' }));

    expect(result.isErr() && result.error).toBe(failure);
    expect(agent.commands).toEqual([]);
  });

  it('fails a verification that cannot observe the work its command left behind', async () => {
    const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
    const { attempt } = await setup({
      settings: runSettings({ verifyCommand: `npm run ${faker.word.verb()}` }),
      exec: (_command, agent) => {
        agent.takeSandboxDown(failure);
        return { exitCode: 0, output: faker.lorem.sentence() };
      },
    });

    const result = await attempt(verifySlice, aSlice({ status: 'verifying' }));

    expect(result.isErr() && result.error).toBe(failure);
  });

  it('tells the reviewer the verify command that passed in the sandbox for the commits under review', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { run, agent, git, runBranch } = await setup({ reviewer: [approval()] });
    const forkPoint = await git.revparse([runBranch]);
    const slice = aSlice({ status: 'in_review', verification: { command: verifyCommand } });

    await run(reviewSlice, slice);

    expect(agent.calls.at(-1)?.prompt).toContain(
      `\`${verifyCommand}\` passed in the sandbox for the commits in \`${forkPoint}..HEAD\``,
    );
  });

  it('changes reviewer guidance when a verification result becomes available', async () => {
    const command = `npm run ${faker.lorem.slug()}`;
    const slice = aSlice({ status: 'in_review', verification: undefined });
    const { run, agent } = await setup({ reviewer: [approval(), approval()] });

    await run(reviewSlice, slice);
    const withoutResult = agent.calls.at(-1)?.prompt ?? '';
    await run(reviewSlice, { ...slice, verification: { command } });
    const withResult = agent.calls.at(-1)?.prompt ?? '';
    const absentGuidance = withoutResult.split('\n').filter((line) => !withResult.includes(line));

    expect(absentGuidance.length).toBeGreaterThan(0);
    expect(withoutResult).not.toContain(command);
    expect(withResult).toContain(command);
    for (const line of absentGuidance) expect(withResult).not.toContain(line);
  });

  it('still tells the reviewer to reject a slice that is only scaffolding', async () => {
    const { run, agent } = await setup({ reviewer: [approval()] });

    await run(reviewSlice, aSlice({ status: 'in_review' }));

    expect(agent.calls.at(-1)?.prompt).toContain(
      'pure scaffolding (types, builders, refactors) for later slices',
    );
  });

  it('tells the reviewer which protected files the reviewed commits touched', async () => {
    const addedSpec = `${faker.lorem.slug()}.spec.ts`;
    const { run, agent } = await setup({
      implementer: [
        {
          files: {
            'feature.txt': faker.lorem.sentence(),
            'package.json': `{\n  "name": "${faker.lorem.word()}"\n}\n`,
            [addedSpec]: faker.lorem.sentence(),
          },
        },
      ],
      reviewer: [approval()],
    });
    const slice = aSlice();
    await run(implementSlice, slice);

    await run(reviewSlice, { ...slice, status: 'in_review' });

    const prompt = agent.calls.at(-1)?.prompt ?? '';
    expect(prompt).toContain('package.json (added)');
    expect(prompt).not.toContain(addedSpec);
    expect(prompt).not.toContain('feature.txt');
  });

  it('flags a test file the reviewed commits modified, and not one they added', async () => {
    const existingSpec = `${faker.lorem.slug()}.spec.ts`;
    const addedTest = `${faker.lorem.slug()}.test.ts`;
    const { run, agent, workspace, sandboxPath, git, runBranch } = await setup({
      implementer: [
        {
          files: {
            [existingSpec]: faker.lorem.paragraph(),
            [addedTest]: faker.lorem.sentence(),
          },
        },
      ],
      reviewer: [approval()],
    });
    await writeFile(path.join(sandboxPath, existingSpec), faker.lorem.sentence());
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
    const slice = aSlice({ order: 1 });
    await run(implementSlice, slice, [previous]);

    await run(reviewSlice, { ...slice, status: 'in_review' }, [previous]);

    const prompt = agent.calls.at(-1)?.prompt ?? '';
    expect(prompt).toContain(`${existingSpec} (modified)`);
    expect(prompt).not.toContain(addedTest);
  });

  it('names every protected file the slice modified, deleted or reconfigured for the reviewer', async () => {
    const existingSpec = `${faker.lorem.slug()}.spec.ts`;
    const secondTest = `${faker.lorem.slug()}.test.ts`;
    const { run, agent, workspace, sandboxPath, git, runBranch } = await setup({
      implementer: [
        {
          files: {
            [existingSpec]: faker.lorem.paragraph(),
            'package.json': `{\n  "name": "${faker.lorem.word()}"\n}\n`,
          },
          deletes: [secondTest],
        },
      ],
      reviewer: [approval()],
    });
    await writeFile(path.join(sandboxPath, existingSpec), faker.lorem.paragraph());
    await writeFile(path.join(sandboxPath, secondTest), faker.lorem.paragraph());
    await writeFile(
      path.join(sandboxPath, 'package.json'),
      `{\n  "name": "${faker.lorem.word()}"\n}\n`,
    );
    (
      await workspace.saveWork(faker.lorem.sentence(), {
        approved: await git.revparse([runBranch]),
      })
    ).unwrap();
    const previous = aSlice({
      order: 0,
      status: 'approved',
      commit: await git.revparse([runBranch]),
    });
    const slice = aSlice({ order: 1 });
    await run(implementSlice, slice, [previous]);

    await run(reviewSlice, { ...slice, status: 'in_review' }, [previous]);

    const prompt = agent.calls.at(-1)?.prompt ?? '';
    expect(prompt).toContain(`${existingSpec} (modified)`);
    expect(prompt).toContain(`${secondTest} (deleted)`);
    expect(prompt).toContain('package.json (modified)');
  });

  it('lists no protected files for a slice that only adds new files', async () => {
    const addedSource = `${faker.lorem.slug()}.ts`;
    const addedSpec = `${faker.lorem.slug()}.spec.ts`;
    const { run, agent } = await setup({
      implementer: [
        {
          files: {
            [addedSource]: faker.lorem.sentence(),
            [addedSpec]: faker.lorem.sentence(),
          },
        },
      ],
      reviewer: [approval()],
    });
    const slice = aSlice();
    await run(implementSlice, slice);

    await run(reviewSlice, { ...slice, status: 'in_review' });

    const prompt = agent.calls.at(-1)?.prompt ?? '';
    expect(prompt).not.toContain(addedSpec);
    expect(prompt).not.toContain('- ');
  });

  it('verifies without running anything when no verify command is configured', async () => {
    const { run, agent } = await setup({ settings: runSettings({ verifyCommand: undefined }) });

    expect(await run(verifySlice, aSlice())).toEqual({ type: 'verified' });
    expect(agent.commands).toEqual([]);
  });

  it('records the verify command it ran, with the work it observed around it', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const output = faker.lorem.sentence();
    const { run, git, runBranch, sandboxPath } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => ({ exitCode: 0, output }),
    });
    const head = await git.revparse([runBranch]);
    const inSandbox = simpleGit({ baseDir: sandboxPath });

    const outcome = await run(verifySlice, aSlice());

    expect(outcome).toMatchObject({ type: 'verified', command: verifyCommand });
    const observed = outcome.type === 'verified' ? outcome.observed : undefined;
    expect(observed).toEqual({
      before: {
        host: { commit: head, tree: await git.revparse([`${runBranch}^{tree}`]), clean: true },
        sandbox: {
          commit: head,
          tree: await inSandbox.revparse(['HEAD^{tree}']),
          clean: true,
        },
      },
      after: {
        host: { commit: head, tree: await git.revparse([`${runBranch}^{tree}`]), clean: true },
        sandbox: {
          commit: head,
          tree: await inSandbox.revparse(['HEAD^{tree}']),
          clean: true,
        },
      },
    });
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

    expect(state.slices[0].verification).toMatchObject({ command: verifyCommand });

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
    expect(outcome).toMatchObject({
      type: 'verificationFailed',
      command: verifyCommand,
      output: failure,
    });
    expect(outcome.type === 'verificationFailed' && outcome.feedback).toContain(failure);
    expect(outcome.type === 'verificationFailed' && outcome.feedback).toContain(verifyCommand);
  });

  it('records the work a failing verify command changed, as the facts around its failure', async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const { run, sandboxPath } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: async () => {
        await writeFile(path.join(sandboxPath, 'leftover.txt'), faker.lorem.sentence());
        return { exitCode: 1, output: faker.lorem.sentence() };
      },
    });
    const slice = aSlice({ status: 'verifying' });

    const outcome = await run(verifySlice, slice);

    expect(outcome.type).toBe('verificationFailed');
    const observed = outcome.type === 'verificationFailed' ? outcome.observed : undefined;
    expect(observed?.before.sandbox.clean).toBe(true);
    expect(observed?.after.sandbox.clean).toBe(false);
    const state = applyOutcome(aRunState({ slices: [slice] }), outcome);
    expect(state.slices[0].failedVerification).toMatchObject({ command: verifyCommand, observed });
    expect(state.slices[0].verificationFailures).toBe(1);
  });

  it("gives the implementer the tail of a failing verify's output, not its head", async () => {
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const head = faker.string.alpha(2000);
    const tail = faker.string.alpha(2000);
    const { run } = await setup({
      settings: runSettings({ verifyCommand }),
      exec: () => ({ exitCode: 1, output: `${head}${tail}` }),
    });

    const outcome = await run(verifySlice, aSlice());

    const feedback = outcome.type === 'verificationFailed' && outcome.feedback;
    expect(feedback).toContain(tail);
    expect(feedback).toContain(verifyCommand);
    expect(feedback).not.toContain(head);
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
    exec?: (
      command: string,
      agent: FakeAgentSession,
    ) => ExecResult | SandboxUnavailable | Promise<ExecResult | SandboxUnavailable>;
    state?: Partial<Omit<RunState, 'phase' | 'runId'>> & { phase?: RunPhase };
  }) {
    const id = runId();
    const created = await createRunWorktree(id);
    const agent = new FakeAgentSession(created.sandboxPath, input.exec);
    const workspace = new GitWorkspace({
      repoRoot: created.repo.dir,
      worktreePath: created.worktreePath,
      runId: id,
      baseBranch: 'main',
      sandbox: agent,
      signing: 'skip',
    });
    agent.script('implementer', ...(input.implementer ?? []));
    agent.script('reviewer', ...(input.reviewer ?? []));
    const state = aRunState({ runId: id, ...input.state });
    const settings = input.settings ?? runSettings();
    const attempt = (step: SliceStep, slice: Slice, earlierSlices: Slice[] = []) =>
      step({
        state: { ...state, slices: [...earlierSlices, slice] },
        slice,
        ports: { agent, workspace, retryResult },
        settings,
      });
    const run = async (step: SliceStep, slice: Slice, earlierSlices: Slice[] = []) =>
      (await attempt(step, slice, earlierSlices)).unwrap();
    return {
      run,
      attempt,
      agent,
      workspace,
      settings,
      state,
      sandboxPath: created.sandboxPath,
      git: created.git,
      runBranch: created.runBranch,
      rejectCommitsInSandbox: created.rejectCommitsInSandbox,
    };
  }
});

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The slice as the flow leaves it once a verification passed on the real repository. */
async function verifiedSlice(
  run: (step: SliceStep, slice: Slice) => Promise<Outcome>,
): Promise<Slice> {
  const verified = await run(verifySlice, aSlice({ status: 'verifying' }));
  const recorded = applyOutcome(aRunState({ slices: [aSlice({ status: 'verifying' })] }), verified);
  return aSlice({ status: 'in_review', verification: recorded.slices[0].verification });
}

/** The run as the engine leaves an approving review: the outcome applied, the slice approved. */
function approvedRun(state: RunState, outcome: Outcome): RunState {
  return updateCurrentSlice(applyOutcome(state, outcome), (current) => ({
    ...current,
    status: 'approved',
  }));
}
