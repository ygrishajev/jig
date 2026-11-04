import { faker } from '@faker-js/faker';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  aFeaturePlan,
  aRunStateIn,
  aSlice,
  runId,
  runSettings,
} from '../../tests/support/builders.js';
import { type AgentScript, FakeAgentSession } from '../../tests/support/fakes.js';
import { createRunWorktree } from '../../tests/support/run-worktree.js';
import { AgentRunFailed, MergeFailed } from '../domain/errors.js';
import type { RunState } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { RunStep } from '../flow/define-flow.js';
import { describePullRequest, mergeRunBranch } from './finishing.js';

describe('finishing steps', () => {
  describe('mergeRunBranch', () => {
    it('merges the run branch into the base branch in auto mode', async () => {
      const { run, commitOnRunBranch, isMerged } = await setup({
        settings: runSettings({ mergeMode: 'auto' }),
      });
      await commitOnRunBranch();

      expect((await run(mergeRunBranch)).unwrap()).toEqual({ type: 'merged' });
      expect(await isMerged()).toBe(true);
    });

    it('waits for a person to merge in manual mode', async () => {
      const { run, commitOnRunBranch, isMerged } = await setup({
        settings: runSettings({ mergeMode: 'manual' }),
      });
      await commitOnRunBranch();

      expect((await run(mergeRunBranch)).unwrap()).toEqual({ type: 'awaitingManualMerge' });
      expect(await isMerged()).toBe(false);
    });

    it('sees a merge a person already did, in either mode', async () => {
      const { run, commitOnRunBranch, mergeByHand } = await setup({
        settings: runSettings({ mergeMode: 'manual' }),
      });
      await commitOnRunBranch();
      await mergeByHand();

      expect((await run(mergeRunBranch)).unwrap()).toEqual({ type: 'merged' });
    });

    it('fails in a way that needs a person when the operator has uncommitted changes', async () => {
      const { run, commitOnRunBranch, dirtyOperatorTree } = await setup({
        settings: runSettings({ mergeMode: 'auto' }),
      });
      await commitOnRunBranch();
      await dirtyOperatorTree();

      const result = await run(mergeRunBranch);

      expect(result.isErr() && result.error).toBeInstanceOf(MergeFailed);
    });
  });

  describe('describePullRequest', () => {
    it("fills the repository's own pull request template", async () => {
      const template = `## ${faker.word.noun()}\n\n<!-- ${faker.lorem.sentence()} -->`;
      const body = faker.lorem.paragraphs();
      const { run, agent, writeRepoFile } = await setup({ describer: { output: { body } } });
      await writeRepoFile('.github/pull_request_template.md', template);

      const outcome = (await run(describePullRequest)).unwrap();

      expect(agent.calls[0].prompt).toContain(template);
      expect(outcome.type === 'described' && outcome.body.startsWith(body)).toBe(true);
    });

    it('falls back to its own description when the describer fails', async () => {
      const plan = aFeaturePlan();
      const { run } = await setup({
        describer: { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) },
        state: { plan },
      });

      const outcome = (await run(describePullRequest)).unwrap();

      expect(outcome.type === 'described' && outcome.body).toContain(plan.summary);
    });

    it('keeps the reviewer feedback of a slice that did not get approved', async () => {
      const lastFeedback = faker.lorem.sentence();
      const { run } = await setup({
        describer: { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) },
        state: { slices: [aSlice({ status: 'stuck', lastFeedback })] },
      });

      const outcome = (await run(describePullRequest)).unwrap();

      expect(outcome.type === 'described' && outcome.body).toContain(`> ${lastFeedback}`);
    });
  });

  async function setup(input: {
    settings?: RunSettings;
    describer?: AgentScript;
    state?: Partial<Omit<RunState, 'phase'>>;
  }) {
    const id = runId();
    const created = await createRunWorktree(id);
    const { workspace } = created;
    const agent = new FakeAgentSession(created.sandboxPath);
    if (input.describer) agent.script('describer', input.describer);
    const state = aRunStateIn('describing', { runId: id, ...input.state });
    const run = (step: RunStep<'describing'>) =>
      step({ state, ports: { agent, workspace }, settings: input.settings ?? runSettings() });

    const commitOnRunBranch = async () => {
      await writeFile(
        path.join(created.sandboxPath, `${faker.string.uuid()}.txt`),
        faker.lorem.sentence(),
      );
      const approved = (await workspace.forkPoint()).unwrap();
      (await workspace.saveWork(faker.lorem.sentence(), { approved })).unwrap();
    };
    const isMerged = async () => (await workspace.isRunBranchMerged()).unwrap();
    const mergeByHand = () => created.git.merge([created.runBranch, '--no-edit']);
    const writeRepoFile = async (relativePath: string, contents: string) => {
      const target = path.join(created.repo.dir, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    };
    const dirtyOperatorTree = () =>
      writeFile(path.join(created.repo.dir, 'README.md'), faker.lorem.paragraph());
    return {
      run,
      agent,
      commitOnRunBranch,
      isMerged,
      mergeByHand,
      writeRepoFile,
      dirtyOperatorTree,
    };
  }
});
