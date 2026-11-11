import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  designApproval,
  designFindings,
  designRevision,
} from '../../tests/support/agent-scripts.js';
import {
  aDesignFinding,
  aDisposition,
  aFirstDesignReview,
  aRevisedDesignReview,
  aRunStateIn,
  designDocs,
  runSettings,
} from '../../tests/support/builders.js';
import { type AgentScript, FakeAgentSession } from '../../tests/support/fakes.js';
import { AgentOutputInvalid, AgentRunFailed, DesignUnresolved } from '../domain/errors.js';
import type { RunPhase, RunStateIn } from '../domain/run-state.js';
import type { RunStep } from '../flow/define-flow.js';
import type { Workspace } from '../ports/workspace.js';
import { resolveDesign, reviewDesign, reviseDesign } from './design-review.js';

describe('design review steps', () => {
  it('has the reviewer review the written design and returns its findings', async () => {
    const findings = [aDesignFinding(), aDesignFinding()];
    const { run, agent } = setup({ reviewer: [designFindings(...findings)] });
    const state = aRunStateIn('reviewingDesign');

    const outcome = await run(reviewDesign, state);

    expect(outcome.unwrap()).toEqual({ type: 'designReviewed', review: { findings } });
    expect(agent.calls).toEqual([
      expect.objectContaining({ role: 'reviewer', kind: 'runForOutput' }),
    ]);
    expect(agent.calls[0].prompt).toContain(state.request);
    expect(agent.calls[0].prompt).toContain(state.docs.plan);
  });

  it('re-reviews a revised design against the documents it replaced and the dispositions', async () => {
    const progress = aRevisedDesignReview();
    const revision = progress.revision;
    const state = aRunStateIn('reviewingDesign', {
      designReview: { reviews: [progress.reviews[0]], revision },
    });
    const { run, agent } = setup({ reviewer: [designApproval()] });

    const outcome = await run(reviewDesign, state);

    expect(outcome.unwrap()).toEqual({ type: 'designReviewed', review: { findings: [] } });
    expect(agent.calls[0].prompt).toContain(revision?.reviewedDocs.plan);
    expect(agent.calls[0].prompt).toContain(state.docs.plan);
    expect(agent.calls[0].prompt).toContain(progress.reviews[0].findings[0].failureScenario);
  });

  it('refuses a review whose findings lack evidence or repeat an id', async () => {
    const repeated = aDesignFinding();
    const { run } = setup({
      reviewer: [
        designFindings(aDesignFinding({ evidence: [] })),
        designFindings(repeated, aDesignFinding({ id: repeated.id })),
      ],
    });

    const unevidenced = await run(reviewDesign, aRunStateIn('reviewingDesign'));
    const duplicated = await run(reviewDesign, aRunStateIn('reviewingDesign'));

    expect(unevidenced.isErr() && unevidenced.error).toBeInstanceOf(AgentOutputInvalid);
    expect(duplicated.isErr() && duplicated.error).toBeInstanceOf(AgentOutputInvalid);
    expect(duplicated.isErr() && duplicated.error.message).toContain(repeated.id);
  });

  it('has the planner revise the design, answering the findings of the first review', async () => {
    const findings = [aDesignFinding(), aDesignFinding()];
    const revised = designDocs();
    const dispositions = findings.map((finding) => aDisposition(finding));
    const state = aRunStateIn('revisingDesign', {
      designReview: aFirstDesignReview({ findings }),
    });
    const { run, agent } = setup({ planner: [designRevision(revised, dispositions)] });

    const outcome = await run(reviseDesign, state);

    expect(outcome.unwrap()).toEqual({
      type: 'designRevised',
      revision: { ...revised, dispositions },
    });
    expect(agent.calls).toEqual([
      expect.objectContaining({ role: 'planner', kind: 'runForOutput' }),
    ]);
    for (const finding of findings) expect(agent.calls[0].prompt).toContain(finding.id);
    expect(agent.calls[0].prompt).toContain(state.docs.design);
  });

  it('refuses a revision that does not answer every finding exactly once', async () => {
    const [answered, skipped] = [aDesignFinding(), aDesignFinding()];
    const state = aRunStateIn('revisingDesign', {
      designReview: aFirstDesignReview({ findings: [answered, skipped] }),
    });
    const { run } = setup({ planner: [designRevision(designDocs(), [aDisposition(answered)])] });

    const outcome = await run(reviseDesign, state);

    expect(outcome.isErr() && outcome.error).toBeInstanceOf(AgentOutputInvalid);
    expect(outcome.isErr() && outcome.error.message).toContain(skipped.id);
  });

  it('propagates a failed reviewer call as it is', async () => {
    const failure = new AgentRunFailed({ message: faker.lorem.sentence() });
    const { run } = setup({ reviewer: [{ fail: failure }] });

    const outcome = await run(reviewDesign, aRunStateIn('reviewingDesign'));

    expect(outcome.isErr() && outcome.error).toBe(failure);
  });

  it('blocks on the findings the re-review still raised, without calling an agent', async () => {
    const outstanding = aDesignFinding();
    const { run, agent } = setup({});

    const unresolved = await run(
      resolveDesign,
      aRunStateIn('resolvingDesign', {
        designReview: aRevisedDesignReview({ outstanding: [outstanding] }),
      }),
    );

    expect(unresolved.isErr() && unresolved.error).toBeInstanceOf(DesignUnresolved);
    expect(unresolved.isErr() && unresolved.error.message).toContain(outstanding.concern);
    expect(agent.calls).toHaveLength(0);
  });

  function setup(input: { reviewer?: AgentScript[]; planner?: AgentScript[] }) {
    const agent = new FakeAgentSession(faker.system.directoryPath());
    if (input.reviewer) agent.script('reviewer', ...input.reviewer);
    if (input.planner) agent.script('planner', ...input.planner);
    const ports = { agent, workspace: mock<Workspace>() };
    const run = <P extends RunPhase>(step: RunStep<P>, state: RunStateIn<P>) =>
      step({ state, ports, settings: runSettings() });
    return { run, agent };
  }
});
