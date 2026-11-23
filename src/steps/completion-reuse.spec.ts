import { faker } from '@faker-js/faker';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  aRunStateIn,
  aSlice,
  designDocs,
  runId,
  runSettings,
} from '../../tests/support/builders.js';
import { createRunWorktree } from '../../tests/support/run-worktree.js';
import { retryResult } from '../adapters/retry.js';
import { completionEvidenceOf } from '../domain/completion-reuse.js';
import { SandboxUnavailable } from '../domain/errors.js';
import type { FulfillmentVerdict } from '../domain/final-check.js';
import type { RunSettings } from '../domain/settings.js';
import { completionInvalidated, decideCompletionReuse } from './completion-reuse.js';

describe('completion reuse steps', () => {
  describe('decideCompletionReuse', () => {
    it('finishes on evidence that still vouches for the work, running no command and asking no agent', async () => {
      const { decide, agent } = await setup({});

      const outcome = (await decide()).unwrap();

      expect(outcome).toEqual({ type: 'completionReused' });
      expect(agent.calls).toEqual([]);
      expect(agent.commands).toEqual([]);
    });

    it('sends a run whose sandbox was left dirty after the review to the final check', async () => {
      const { decide, dirtySandbox } = await setup({});
      await dirtySandbox();

      expect((await decide()).unwrap()).toEqual({ type: 'completionDeclined' });
    });

    it('sends a run whose review left gaps to the final check without observing the work', async () => {
      const { decide, takeSandboxDown } = await setup({
        verdict: { fulfilled: true, gaps: [faker.lorem.sentence()] },
      });
      takeSandboxDown();

      expect((await decide()).unwrap()).toEqual({ type: 'completionDeclined' });
    });

    it('reports a sandbox it cannot observe instead of deciding without it', async () => {
      const { decide, takeSandboxDown } = await setup({});
      const failure = takeSandboxDown();

      const decided = await decide();

      expect(decided.isErr() && decided.error).toBe(failure);
    });
  });

  describe('completionInvalidated', () => {
    it('stands by authorized evidence that still vouches for the work', async () => {
      const { invalidated } = await setup({ authorized: true });

      expect((await invalidated()).unwrap()).toBe(false);
    });

    it('invalidates authorized evidence once the work it vouched for is left dirty', async () => {
      const { invalidated, dirtySandbox } = await setup({ authorized: true });
      await dirtySandbox();

      expect((await invalidated()).unwrap()).toBe(true);
    });

    it('invalidates authorized evidence once the settings it ran under changed', async () => {
      const { invalidated } = await setup({
        authorized: true,
        finishingSettings: runSettings({ verifyCommand: `npm run ${faker.word.verb()}` }),
      });

      expect((await invalidated()).unwrap()).toBe(true);
    });

    it('never invalidates a run that finishes without reused evidence, observing nothing', async () => {
      const { invalidated, takeSandboxDown } = await setup({ authorized: false });
      takeSandboxDown();

      expect((await invalidated()).unwrap()).toBe(false);
    });
  });

  async function setup(input: {
    verdict?: FulfillmentVerdict;
    authorized?: boolean;
    finishingSettings?: RunSettings;
  }) {
    const id = runId();
    const { agent, workspace, sandboxPath } = await createRunWorktree(id);
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const settings = runSettings({ verifyCommand });
    const request = `# ${faker.lorem.sentence()}`;
    const docs = designDocs();
    const facts = (await workspace.collectFacts()).unwrap();
    const forkPoint = (await workspace.forkPoint()).unwrap();
    const verification = {
      command: verifyCommand,
      observed: { before: facts, after: facts },
    };
    const recorded = {
      runId: id,
      request,
      docs,
      slices: [aSlice({ status: 'approved', verification })],
      completionReuse: completionEvidenceOf({
        reviewed: { request, plan: docs.plan },
        settings,
        verification,
        verdict: input.verdict ?? { fulfilled: true, gaps: [] },
        observed: { before: facts, after: facts },
        range: { start: forkPoint, end: facts.host.commit },
      }),
      completionReuseAuthorized: input.authorized ? (true as const) : undefined,
    };
    const ports = { agent, workspace, retryResult };
    const finishingSettings = input.finishingSettings ?? settings;
    const decide = () =>
      decideCompletionReuse({
        state: aRunStateIn('checkingReuse', recorded),
        ports,
        settings: finishingSettings,
      });
    const invalidated = () =>
      completionInvalidated({
        state: aRunStateIn('describing', recorded),
        ports,
        settings: finishingSettings,
      });
    const dirtySandbox = () =>
      writeFile(path.join(sandboxPath, `${faker.string.uuid()}.txt`), faker.lorem.sentence());
    const takeSandboxDown = () => {
      const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
      agent.takeSandboxDown(failure);
      return failure;
    };
    return { decide, invalidated, agent, dirtySandbox, takeSandboxDown };
  }
});
