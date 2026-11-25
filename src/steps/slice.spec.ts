import { faker } from '@faker-js/faker';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { approval, rejection, ruleFindings } from '../../tests/support/agent-scripts.js';
import {
  aRunState,
  aSlice,
  aVerification,
  designDocs,
  runSettings,
} from '../../tests/support/builders.js';
import { FakeWorkspace } from '../../tests/support/fake-workspace.js';
import { type AgentScript, FakeAgentSession } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { settingsIdentityOf } from '../domain/completion-reuse.js';
import type { RunPhase, RunState } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { Slice } from '../domain/slice.js';
import type { SliceStep } from '../flow/define-flow.js';
import { AgentRunFailed, type ExecResult, SandboxUnavailable } from '../ports/agent-session.js';
import { implementSlice, reviewSlice, verifySlice } from './slice.js';

describe('slice steps', () => {
  describe('implementSlice', () => {
    it('commits what the implementer changed with the message it replied with', async () => {
      const commitMessage = faker.lorem.sentence();
      const work = { [`${faker.string.uuid()}.txt`]: faker.lorem.sentence() };
      const { run, workspace } = await setup({
        implementer: [{ files: work, output: { commitMessage } }],
      });

      const outcome = await run(implementSlice, aSlice());

      expect(workspace.history).toEqual([{ message: commitMessage, files: work }]);
      const sha = unwrap(await workspace.headCommit());
      expect(outcome).toMatchObject({ type: 'implemented', commit: { sha, filesChanged: 1 } });
    });

    it.each([
      ['no reply', undefined],
      ['a blank message', { commitMessage: ' ' }],
    ])('commits with the slice title when the implementer leaves %s', async (_kind, output) => {
      const slice = aSlice();
      const { run, workspace } = await setup({ implementer: [{ ...someWork(), output }] });

      await run(implementSlice, slice);

      expect(workspace.history.map(({ message }) => message)).toEqual([slice.title]);
    });

    it('measures only the latest attempt, not the ones before it', async () => {
      const { run } = await setup({ implementer: [someWork(), someWork()] });
      const slice = aSlice();

      await run(implementSlice, slice);

      expect(await run(implementSlice, slice)).toMatchObject({ commit: { filesChanged: 1 } });
    });

    it('reports a failed implementer run without committing anything', async () => {
      const failure = new AgentRunFailed({ message: faker.lorem.sentence() });
      const { attempt, workspace } = await setup({ implementer: [{ fail: failure }] });

      const result = await attempt(implementSlice, aSlice());

      expect(result.isErr() && result.error).toBe(failure);
      expect(workspace.history).toEqual([]);
    });

    it("sends the slice back with the hooks' output when the repository's hooks reject its work", async () => {
      const hookOutput = faker.lorem.words(4);
      const { run, workspace } = await setup({ implementer: [someWork()] });
      workspace.rejectNextCommit(hookOutput);

      expect(await run(implementSlice, aSlice())).toMatchObject({
        type: 'hookRejected',
        feedback: expect.stringContaining(hookOutput),
      });
    });

    it('fails when its work cannot follow the approved commit, instead of sending it back', async () => {
      const { attempt } = await setup({ implementer: [someWork()] });
      const approved = aSlice({ order: 0, status: 'approved', commit: faker.git.commitSha() });

      const result = await attempt(implementSlice, aSlice({ order: 1 }), [approved]);

      expect(result.isErr() && result.error._tag).toBe('CommitImportRefused');
    });

    it('sends a slice that changed nothing back with the feedback it was meant to address', async () => {
      const lastFeedback = faker.lorem.sentence();
      const { run } = await setup({ implementer: [{ files: {} }] });

      expect(await run(implementSlice, aSlice({ lastFeedback }))).toMatchObject({
        type: 'nothingChanged',
        feedback: expect.stringContaining(lastFeedback),
      });
    });

    it('takes work an interrupted attempt left committed as the change of one that adds nothing', async () => {
      const { run } = await setup({ implementer: [someWork(), { files: {} }] });
      const slice = aSlice();
      await run(implementSlice, slice);

      expect(await run(implementSlice, slice)).toMatchObject({ type: 'implemented' });
    });
  });

  describe('reviewSlice', () => {
    it('reviews every attempt at the first slice, from where the run branch was cut', async () => {
      const { run, agent, workspace } = await setup({
        implementer: [someWork(), someWork()],
        reviewer: [approval()],
      });
      const slice = aSlice();
      await run(implementSlice, slice);
      const commit = unwrap(await workspace.headCommit());
      await run(implementSlice, { ...slice, commit });

      await run(reviewSlice, { ...slice, commit });

      const forkPoint = unwrap(await workspace.forkPoint());
      expect(agent.calls.at(-1)?.prompt).toContain(`${forkPoint}..HEAD`);
    });

    it('reviews a later slice from where the one before it ended', async () => {
      const { run, agent, workspace } = await setup({
        implementer: [someWork(), someWork(), someWork()],
        reviewer: [approval()],
      });
      const earlier: Slice[] = [];
      for (const order of [0, 1]) {
        await run(implementSlice, aSlice({ order }), earlier);
        const commit = unwrap(await workspace.headCommit());
        earlier.push(aSlice({ order, status: 'approved', commit }));
      }
      const slice = aSlice({ order: 2 });
      const unstarted = aSlice({ order: 3 });
      await run(implementSlice, slice, [...earlier, unstarted]);

      await run(reviewSlice, slice, [unstarted, ...earlier]);

      expect(agent.calls.at(-1)?.prompt).toContain(`${earlier[1].commit}..HEAD`);
    });

    it('names the protected files the reviewed commits changed, and no others', async () => {
      const existingSpec = `${faker.string.uuid()}.spec.ts`;
      const deletedSpec = `${faker.string.uuid()}.spec.ts`;
      const addedSpec = `${faker.string.uuid()}.spec.ts`;
      const { run, agent, workspace } = await setup({
        implementer: [
          { files: { [existingSpec]: faker.lorem.word(), [deletedSpec]: faker.lorem.word() } },
          {
            files: { [existingSpec]: faker.lorem.paragraph(), [addedSpec]: faker.lorem.word() },
            deletes: [deletedSpec],
          },
        ],
        reviewer: [approval()],
      });
      await run(implementSlice, aSlice({ order: 0 }));
      const commit = unwrap(await workspace.headCommit());
      const earlier = [aSlice({ order: 0, status: 'approved', commit })];
      const slice = aSlice({ order: 1 });
      await run(implementSlice, slice, earlier);

      await run(reviewSlice, slice, earlier);

      const prompt = agent.calls.at(-1)?.prompt;
      expect(prompt).toContain(`${existingSpec} (modified)`);
      expect(prompt).toContain(`${deletedSpec} (deleted)`);
      expect(prompt).not.toContain(addedSpec);
    });

    it('turns the verdict into an approval, a change request or a rule fix request', async () => {
      const feedback = faker.lorem.sentence();
      const { run } = await setup({
        reviewer: [approval(), rejection(feedback), ruleFindings(feedback)],
      });

      expect(await run(reviewSlice, aSlice())).toEqual({ type: 'approved' });
      expect(await run(reviewSlice, aSlice())).toEqual({ type: 'changesRequested', feedback });
      expect(await run(reviewSlice, aSlice())).toEqual({ type: 'rulesFixRequested', feedback });
    });

    it.each(['context', 'slices'] as const)(
      'fails on a verdict it cannot read, in %s',
      async (phase) => {
        const { attempt } = await setup({
          reviewer: [{ output: { verdict: faker.lorem.word() } }],
          state: { phase },
        });

        const result = await attempt(reviewSlice, aSlice());

        expect(result.isErr() && result.error._tag).toBe('AgentOutputInvalid');
      },
    );

    it('reviews one slice of several on its own, without the request', async () => {
      const { run, agent, state } = await setup({
        reviewer: [approval()],
        state: { phase: 'slices' },
      });

      const outcome = await run(reviewSlice, aSlice({ order: 1 }), [aSlice({ order: 0 })]);

      expect(outcome).toEqual({ type: 'approved' });
      expect(agent.calls[0].prompt).not.toContain(state.request);
    });

    describe('of a run whose single slice is its whole work', () => {
      it('judges the whole request too, recording what it saw as completion evidence', async () => {
        const docs = designDocs();
        const verification = aVerification();
        const { run, agent, state, settings, workspace } = await setup({
          implementer: [someWork()],
          reviewer: [approval()],
          state: { phase: 'slices', docs },
        });
        await run(implementSlice, aSlice());

        const outcome = await run(reviewSlice, aSlice({ verification }));

        const { host, sandbox } = unwrap(await workspace.collectFacts());
        const start = unwrap(await workspace.forkPoint());
        expect(outcome).toEqual({
          type: 'approved',
          completion: {
            verdict: { fulfilled: true, gaps: [] },
            verification,
            settingsIdentity: settingsIdentityOf(settings),
            checked: { commit: host.commit, tree: host.tree },
            observed: { before: { host, sandbox }, after: { host, sandbox } },
            scope: {
              request: digestOf(state.request),
              plan: digestOf(docs.plan),
              range: { start, end: host.commit },
            },
          },
        });
        const prompt = agent.calls.at(-1)?.prompt;
        expect(prompt).toContain(state.request);
        expect(prompt).toContain(docs.plan);
        expect(prompt).toContain(`${start}..HEAD`);
      });

      it('records the work a reviewer changed while it judged', async () => {
        const { run } = await setup({
          reviewer: [{ ...someWork(), ...approval() }],
          state: { phase: 'slices' },
        });

        expect(await run(reviewSlice, aSlice())).toMatchObject({
          completion: {
            observed: {
              before: { sandbox: { clean: true } },
              after: { sandbox: { clean: false } },
            },
          },
        });
      });

      it.each([
        ['approves the code but not the request', true, false, 'approved'],
        ['rejects the code but not the request', false, true, 'changesRequested'],
      ] as const)(
        'keeps the request verdict of a review that %s',
        async (_verdict, approved, fulfilled, type) => {
          const gaps = fulfilled ? [] : [faker.lorem.sentence()];
          const { run } = await setup({
            reviewer: [{ output: { approved, feedback: faker.lorem.word(), fulfilled, gaps } }],
            state: { phase: 'slices' },
          });

          expect(await run(reviewSlice, aSlice())).toMatchObject({
            type,
            completion: { verdict: { fulfilled, gaps } },
          });
        },
      );

      it.each([
        ['missing', {}],
        ['invalid', { fulfilled: faker.lorem.word(), gaps: [] }],
      ])('approves without evidence when the request verdict is %s', async (_kind, verdict) => {
        const { run } = await setup({
          reviewer: [{ output: { approved: true, feedback: '', ...verdict } }],
          state: { phase: 'slices' },
        });

        expect(await run(reviewSlice, aSlice())).toEqual({ type: 'approved' });
      });

      it('fails when it cannot observe the work before the review, without asking the reviewer', async () => {
        const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
        const { attempt, agent } = await setup({ state: { phase: 'slices' } });
        agent.takeSandboxDown(failure);

        const result = await attempt(reviewSlice, aSlice());

        expect(result.isErr() && result.error).toBe(failure);
        expect(agent.calls).toHaveLength(0);
      });

      it('fails when it cannot observe the work after the review', async () => {
        const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
        const { attempt } = await setup({
          reviewer: [{ ...approval(), takesSandboxDown: failure }],
          state: { phase: 'slices' },
        });

        const result = await attempt(reviewSlice, aSlice());

        expect(result.isErr() && result.error).toBe(failure);
      });
    });
  });

  describe('verifySlice', () => {
    it('runs nothing when no verify command is configured', async () => {
      const { run, agent } = await setup({ settings: { verifyCommand: undefined } });

      expect(await run(verifySlice, aSlice())).toEqual({ type: 'verified' });
      expect(agent.commands).toEqual([]);
    });

    it('records the command that passed and the work around it', async () => {
      const command = `npm run ${faker.word.verb()}`;
      const { run, agent, workspace } = await setup({ settings: { verifyCommand: command } });
      const facts = unwrap(await workspace.collectFacts());

      expect(await run(verifySlice, aSlice())).toEqual({
        type: 'verified',
        verification: { command, observed: { before: facts, after: facts } },
      });
      expect(agent.commands).toEqual([command]);
    });

    it('sends the slice back with the output of a command that failed and the work it left', async () => {
      const command = `npm run ${faker.word.verb()}`;
      const output = faker.lorem.sentence();
      const { run } = await setup({
        settings: { verifyCommand: command },
        exec: async (agent) => {
          await writeFile(path.join(agent.sandboxPath, faker.string.uuid()), faker.lorem.word());
          return { exitCode: 1, output };
        },
      });

      const outcome = await run(verifySlice, aSlice());

      expect(outcome).toMatchObject({
        type: 'verificationFailed',
        command,
        output,
        observed: { before: { sandbox: { clean: true } }, after: { sandbox: { clean: false } } },
      });
      const feedback = outcome.type === 'verificationFailed' && outcome.feedback;
      expect(feedback).toContain(command);
      expect(feedback).toContain(output);
    });

    it("gives the implementer the tail of a failing command's output, not its head", async () => {
      const [head, tail] = [faker.string.alpha(2000), faker.string.alpha(2000)];
      const { run } = await setup({
        settings: { verifyCommand: `npm run ${faker.word.verb()}` },
        exec: () => ({ exitCode: 1, output: `${head}${tail}` }),
      });

      const outcome = await run(verifySlice, aSlice());

      const feedback = outcome.type === 'verificationFailed' && outcome.feedback;
      expect(feedback).toContain(tail);
      expect(feedback).not.toContain(head);
    });

    it('fails when it cannot observe the work before the command, without running it', async () => {
      const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
      const { attempt, agent } = await setup({
        settings: { verifyCommand: `npm run ${faker.word.verb()}` },
      });
      agent.takeSandboxDown(failure);

      const result = await attempt(verifySlice, aSlice());

      expect(result.isErr() && result.error).toBe(failure);
      expect(agent.commands).toEqual([]);
    });

    it.each([
      [
        'cannot run the command',
        (_agent: FakeAgentSession, failure: SandboxUnavailable) => failure,
      ],
      [
        'goes down while it runs',
        (agent: FakeAgentSession, failure: SandboxUnavailable) => {
          agent.takeSandboxDown(failure);
          return { exitCode: 0, output: faker.lorem.sentence() };
        },
      ],
    ])('passes on a sandbox that %s', async (_kind, fail) => {
      const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
      const { attempt } = await setup({
        settings: { verifyCommand: `npm run ${faker.word.verb()}` },
        exec: (agent) => fail(agent, failure),
      });

      const result = await attempt(verifySlice, aSlice());

      expect(result.isErr() && result.error).toBe(failure);
    });
  });

  async function setup({
    implementer = [],
    reviewer = [],
    settings: overrides = {},
    exec = () => ({ exitCode: 0, output: faker.lorem.sentence() }),
    state: stateOverrides = {},
  }: {
    implementer?: AgentScript[];
    reviewer?: AgentScript[];
    settings?: Partial<RunSettings>;
    exec?: (
      agent: FakeAgentSession,
    ) => ExecResult | SandboxUnavailable | Promise<ExecResult | SandboxUnavailable>;
    state?: Partial<Omit<RunState, 'phase'>> & { phase?: RunPhase };
  }) {
    const agent = new FakeAgentSession(await tempDirectory(), (_command, session) => exec(session));
    const workspace = new FakeWorkspace(agent);
    agent.script('implementer', ...implementer);
    agent.script('reviewer', ...reviewer);
    const state = aRunState(stateOverrides);
    const settings = runSettings(overrides);
    const attempt = (step: SliceStep, slice: Slice, others: Slice[] = []) =>
      step({
        state: { ...state, slices: [...others, slice] },
        slice,
        ports: { agent, workspace },
        settings,
      });
    const run = async (step: SliceStep, slice: Slice, others: Slice[] = []) =>
      unwrap(await attempt(step, slice, others));
    return { run, attempt, agent, workspace, settings, state };
  }
});

function someWork() {
  return { files: { [`${faker.string.uuid()}.txt`]: faker.lorem.sentence() } };
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
