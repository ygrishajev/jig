import { faker } from '@faker-js/faker';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { aRunStateIn, aSlice, runId, runSettings } from '../../tests/support/builders.js';
import { type AgentScript, FakeAgentSession } from '../../tests/support/fakes.js';
import { createRunWorktree } from '../../tests/support/run-worktree.js';
import type { RunState } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { RunStep } from '../flow/define-flow.js';
import { MergeFailed } from '../ports/workspace.js';
import { mergeRunBranch } from './finishing.js';

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

    it('refuses to merge when the branch tip is not what was last approved', async () => {
      const { run, commitOnRunBranch, approve, isMerged } = await setup({
        settings: runSettings({ mergeMode: 'auto' }),
      });
      const approved = await commitOnRunBranch();
      await commitOnRunBranch();
      approve(approved);

      const refusal = await run(mergeRunBranch);

      expect(refusal.isErr() && refusal.error).toBeInstanceOf(MergeFailed);
      expect(await isMerged()).toBe(false);
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
    let approvedCommit: string | undefined;
    const approve = (commit: string) => {
      approvedCommit = commit;
    };
    const run = (step: RunStep<'describing'>) =>
      step({
        state: approvedCommit
          ? { ...state, slices: [aSlice({ status: 'approved', commit: approvedCommit })] }
          : state,
        ports: { agent, workspace },
        settings: input.settings ?? runSettings(),
      });

    const commitOnRunBranch = async () => {
      await writeFile(
        path.join(created.sandboxPath, `${faker.string.uuid()}.txt`),
        faker.lorem.sentence(),
      );
      const approved = approvedCommit ?? (await workspace.forkPoint()).unwrap();
      (await workspace.saveWork(faker.lorem.sentence(), { approved })).unwrap();
      const head = (await workspace.headCommit()).unwrap();
      approve(head);
      return head;
    };
    const isMerged = async () => (await workspace.isRunBranchMerged()).unwrap();
    const mergeByHand = () => created.git.merge([created.runBranch, '--no-edit']);
    const dirtyOperatorTree = () =>
      writeFile(path.join(created.repo.dir, 'README.md'), faker.lorem.paragraph());
    return {
      approve,
      run,
      agent,
      commitOnRunBranch,
      isMerged,
      mergeByHand,
      dirtyOperatorTree,
    };
  }
});
