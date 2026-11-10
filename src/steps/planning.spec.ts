import { faker } from '@faker-js/faker';
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
import { AgentOutputInvalid } from '../domain/errors.js';
import type { RunPhase, RunStateIn } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import { SLICE_ID_MESSAGE } from '../domain/slice.js';
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
    const { run, agent } = setup({ turn: { output: context } });
    const state = aRunState();

    expect((await run(buildContext, state)).unwrap()).toEqual({ type: 'contextBuilt', context });
    expect(agent.calls[0]).toMatchObject({ role: 'planner' });
    expect(agent.calls[0].prompt).toContain(state.request);
  });

  it('plans the feature from the request and the repository summary', async () => {
    const plan = aFeaturePlan();
    const context = aContext();
    const { run, agent } = setup({ turn: { output: plan } });

    expect((await run(planFeature, aRunStateIn('planning', { context }))).unwrap()).toEqual({
      type: 'featurePlanned',
      plan,
    });
    expect(agent.calls[0].prompt).toContain(context.repoSummary);
  });

  it('returns the design and plan documents instead of having them written to disk', async () => {
    const docs = designDocs();
    const { run } = setup({ turn: { output: docs } });

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
    const { run, agent } = setup({ turn: { output: slices } });

    expect((await run(sliceThePlan, aRunStateIn('slicing', { docs }))).unwrap()).toEqual({
      type: 'sliced',
      slices,
    });
    expect(agent.calls[0].prompt).toContain(docs.plan);
  });

  it('rejects a slice plan that leaves a plan step unimplemented', async () => {
    const docs = designDocs({
      plan: `# Plan\n\n## Step 1 — ${faker.lorem.sentence()}\n## Step 2 — ${faker.lorem.sentence()}\n`,
    });
    const { run } = setup({
      turn: { output: [aPlannedSlice({ description: implementingPlanSteps(1) })] },
    });

    const result = await run(sliceThePlan, aRunStateIn('slicing', { docs }));

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
    expect(result.isErr() && result.error.message).toContain('plan step 2');
  });

  it('rejects a slice plan that repeats an id', async () => {
    const repeated = aPlannedSlice({ description: implementingPlanSteps(1) });
    const { run } = setup({
      turn: {
        output: [
          repeated,
          aPlannedSlice({ id: repeated.id, description: implementingPlanSteps(1) }),
        ],
      },
    });

    const result = await run(sliceThePlan, aRunStateIn('slicing', { docs: designDocs() }));

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
    expect(result.isErr() && result.error.message).toContain('repeats slice ids');
    expect(result.isErr() && result.error.message).toContain(repeated.id);
  });

  it('rejects a slice plan with no slices or with an unsafe id', async () => {
    const empty = setup({ turn: { output: [] } });
    const unsafe = setup({
      turn: {
        output: [
          aPlannedSlice({
            id: `${faker.word.noun()} ${faker.word.noun()}`,
            description: implementingPlanSteps(1),
          }),
        ],
      },
    });

    const emptied = await empty.run(sliceThePlan, aRunStateIn('slicing', { docs: designDocs() }));
    const unsafed = await unsafe.run(sliceThePlan, aRunStateIn('slicing', { docs: designDocs() }));

    expect(emptied.isErr() && emptied.error).toBeInstanceOf(AgentOutputInvalid);
    expect(unsafed.isErr() && unsafed.error).toBeInstanceOf(AgentOutputInvalid);
    expect(unsafed.isErr() && unsafed.error.message).toContain(SLICE_ID_MESSAGE);
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

  function setup(input: { turn?: AgentScript; settings?: RunSettings }) {
    const agent = new FakeAgentSession(faker.system.directoryPath());
    if (input.turn) agent.script('planner', input.turn);
    const ports = { agent, workspace: mock<Workspace>() };
    const run = <P extends RunPhase>(step: RunStep<P>, state: RunStateIn<P>) =>
      step({ state, ports, settings: input.settings ?? runSettings() });
    return { run, agent };
  }
});
