import { faker } from '@faker-js/faker';
import { panic } from 'better-result';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  aContext,
  aFeaturePlan,
  aPlannedSlice,
  aRunState,
  aRunStateIn,
  designDocs,
  implementingPlanSteps,
  runSettings,
} from '../../tests/support/builders.js';
import { type AgentScript, FakeAgentSession } from '../../tests/support/fakes.js';
import { AgentOutputInvalid, AgentRunFailed, PlanNotCovered } from '../domain/errors.js';
import { checkPlanCoverage } from '../domain/plan-coverage.js';
import type { RunPhase, RunStateIn } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import { type PlannedSlice, SLICE_ID_MESSAGE } from '../domain/slice.js';
import type { RunStep } from '../flow/define-flow.js';
import type { Workspace } from '../ports/workspace.js';
import {
  applyDesignGate,
  buildContext,
  planFeature,
  sliceThePlan,
  writeDesign,
} from './planning.js';

describe('planning steps', () => {
  it('builds the context from what the planner reports about the request', async () => {
    const context = aContext();
    const { run, agent } = setup({ turns: [{ output: context }] });
    const state = aRunState();

    expect((await run(buildContext, state)).unwrap()).toEqual({ type: 'contextBuilt', context });
    expect(agent.calls[0]).toMatchObject({ role: 'planner' });
    expect(agent.calls[0].prompt).toContain(state.request);
  });

  it('plans the feature from the request and the repository summary', async () => {
    const plan = aFeaturePlan();
    const context = aContext();
    const { run, agent } = setup({ turns: [{ output: plan }] });

    expect((await run(planFeature, aRunStateIn('planning', { context }))).unwrap()).toEqual({
      type: 'featurePlanned',
      plan,
    });
    expect(agent.calls[0].prompt).toContain(context.repoSummary);
  });

  it('returns the design and plan documents instead of having them written to disk', async () => {
    const docs = designDocs();
    const { run } = setup({ turns: [{ output: docs }] });

    const outcome = await run(
      writeDesign,
      aRunStateIn('designing', { context: aContext(), plan: aFeaturePlan() }),
    );

    expect(outcome.unwrap()).toEqual({ type: 'designWritten', docs });
  });

  it('slices the plan document', async () => {
    const slices = [
      aPlannedSlice({ description: implementingPlanSteps(1) }),
      aPlannedSlice({ description: implementingPlanSteps(1) }),
    ];
    const docs = designDocs();
    const { run, agent } = setup({ turns: [{ output: slices }] });

    expect((await run(sliceThePlan, aRunStateIn('slicing', { docs }))).unwrap()).toEqual({
      type: 'sliced',
      slices,
    });
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0].prompt).toContain(docs.plan);
  });

  it('takes the corrected answer when the first slice plan fails the coverage check', async () => {
    const docs = designDocs({ plan: planWithSteps(1, 2) });
    const unanswered = [aPlannedSlice({ description: implementingPlanSteps(1) })];
    const corrected = [
      aPlannedSlice({ description: implementingPlanSteps(1) }),
      aPlannedSlice({ description: implementingPlanSteps(2) }),
    ];
    const { run, agent } = setup({ turns: [{ output: unanswered }, { output: corrected }] });
    const problems = coverageProblems(docs.plan, unanswered);

    expect((await run(sliceThePlan, aRunStateIn('slicing', { docs }))).unwrap()).toEqual({
      type: 'sliced',
      slices: corrected,
    });
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[0].prompt).not.toContain(problems);
    expect(agent.calls[1].prompt).toContain(docs.plan);
    expect(agent.calls[1].prompt).toContain(problems);
  });

  it("returns the second answer's coverage problems after one failed correction", async () => {
    const docs = designDocs({ plan: planWithSteps(1, 2) });
    const unanswered = [aPlannedSlice({ description: implementingPlanSteps(1) })];
    const overreaching = [aPlannedSlice({ description: implementingPlanSteps(3) })];
    const { run, agent } = setup({ turns: [{ output: unanswered }, { output: overreaching }] });

    const result = await run(sliceThePlan, aRunStateIn('slicing', { docs }));

    expect(agent.calls).toHaveLength(2);
    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
    expect(result.isErr() && result.error.message).toBe(coverageProblems(docs.plan, overreaching));
  });

  it('rejects a slice plan that repeats an id', async () => {
    const repeated = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { run, agent } = setup({
      turns: [
        {
          output: [
            repeated,
            aPlannedSlice({ id: repeated.id, description: implementingPlanSteps(1) }),
          ],
        },
      ],
    });

    const result = await run(sliceThePlan, aRunStateIn('slicing', { docs: designDocs() }));

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
    expect(result.isErr() && result.error.message).toContain('repeats slice ids');
    expect(result.isErr() && result.error.message).toContain(repeated.id);
    expect(agent.calls).toHaveLength(1);
  });

  it('rejects a slice plan with no slices or with an unsafe id', async () => {
    const empty = setup({ turns: [{ output: [] }] });
    const unsafe = setup({
      turns: [
        {
          output: [
            aPlannedSlice({
              id: `${faker.word.noun()} ${faker.word.noun()}`,
              description: implementingPlanSteps(1),
            }),
          ],
        },
      ],
    });

    const emptied = await empty.run(sliceThePlan, aRunStateIn('slicing', { docs: designDocs() }));
    const unsafed = await unsafe.run(sliceThePlan, aRunStateIn('slicing', { docs: designDocs() }));

    expect(emptied.isErr() && emptied.error).toBeInstanceOf(AgentOutputInvalid);
    expect(unsafed.isErr() && unsafed.error).toBeInstanceOf(AgentOutputInvalid);
    expect(unsafed.isErr() && unsafed.error.message).toContain(SLICE_ID_MESSAGE);
    expect(empty.agent.calls).toHaveLength(1);
    expect(unsafe.agent.calls).toHaveLength(1);
  });

  it('propagates a failed planner call without asking for a correction', async () => {
    const failure = new AgentRunFailed({ message: faker.lorem.sentence() });
    const { run, agent } = setup({ turns: [{ fail: failure }] });

    const result = await run(sliceThePlan, aRunStateIn('slicing', { docs: designDocs() }));

    expect(result.isErr() && result.error).toBe(failure);
    expect(agent.calls).toHaveLength(1);
  });

  it('rejects a correction that is not a slice array or repeats an id, without asking again', async () => {
    const docs = designDocs({ plan: planWithSteps(1, 2) });
    const repeated = aPlannedSlice({ description: implementingPlanSteps(1) });
    const shapeless = setup({
      turns: [
        { output: [aPlannedSlice({ description: implementingPlanSteps(1) })] },
        { output: { slices: implementingPlanSteps(2) } },
      ],
    });
    const duplicated = setup({
      turns: [
        { output: [aPlannedSlice({ description: implementingPlanSteps(1) })] },
        {
          output: [
            repeated,
            aPlannedSlice({ id: repeated.id, description: implementingPlanSteps(2) }),
          ],
        },
      ],
    });

    const shape = await shapeless.run(sliceThePlan, aRunStateIn('slicing', { docs }));
    const ids = await duplicated.run(sliceThePlan, aRunStateIn('slicing', { docs }));

    expect(shape.isErr() && shape.error).toBeInstanceOf(AgentOutputInvalid);
    expect(ids.isErr() && ids.error.message).toContain('repeats slice ids');
    expect(ids.isErr() && ids.error.message).toContain(repeated.id);
    expect(shapeless.agent.calls).toHaveLength(2);
    expect(duplicated.agent.calls).toHaveLength(2);
  });

  it('reports a plan without step headings explicitly', async () => {
    const docs = designDocs({ plan: `# Plan\n\n${faker.lorem.paragraph()}\n` });
    const { run, agent } = setup({
      turns: [
        { output: [aPlannedSlice({ description: implementingPlanSteps(1) })] },
        { output: [aPlannedSlice({ description: implementingPlanSteps(1) })] },
      ],
    });

    const result = await run(sliceThePlan, aRunStateIn('slicing', { docs }));

    expect(agent.calls).toHaveLength(2);
    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
    expect(result.isErr() && result.error.message).toContain('no step headings');
  });

  it('pauses for a person after planning only when the design gate is a checkpoint', async () => {
    const checkpoint = setup({ settings: runSettings({ designGate: 'checkpoint' }) });
    const automatic = setup({ settings: runSettings({ designGate: 'auto' }) });

    expect((await checkpoint.run(applyDesignGate, aRunState())).unwrap()).toEqual({
      type: 'pause',
    });
    expect((await automatic.run(applyDesignGate, aRunState())).unwrap()).toEqual({
      type: 'continue',
    });
  });

  function setup(input: { turns?: AgentScript[]; settings?: RunSettings }) {
    const agent = new FakeAgentSession(faker.system.directoryPath());
    if (input.turns) agent.script('planner', ...input.turns);
    const ports = { agent, workspace: mock<Workspace>() };
    const run = <P extends RunPhase>(step: RunStep<P>, state: RunStateIn<P>) =>
      step({ state, ports, settings: input.settings ?? runSettings() });
    return { run, agent };
  }

  function coverageProblems(plan: string, slices: PlannedSlice[]): string {
    const checked = checkPlanCoverage(plan, slices);
    if (checked.isOk()) panic('expected the fixture answer to fail the coverage check');
    return checked.error.message;
  }

  function planWithSteps(...steps: number[]): string {
    return `# Plan\n\n${steps
      .map((step) => `## Step ${step} — ${faker.lorem.sentence()}`)
      .join('\n')}\n`;
  }
});
