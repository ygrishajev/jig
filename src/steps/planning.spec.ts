import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AgentOutputInvalid } from '../domain/errors.js';
import type { RunState } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { Workspace } from '../ports/workspace.js';
import {
  aContext,
  aFeaturePlan,
  aPlannedSlice,
  aRunState,
  designDocs,
  runSettings,
} from '../../tests/support/builders.js';
import { FakeAgentSession, type AgentScript } from '../../tests/support/fakes.js';
import type { RunStep } from '../flow/define-flow.js';
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

    expect(await run(buildContext, state)).toEqual({ type: 'contextBuilt', context });
    expect(agent.calls[0]).toMatchObject({ role: 'planner' });
    expect(agent.calls[0].prompt).toContain(state.request);
  });

  it('plans the feature from the request and the repository summary', async () => {
    const plan = aFeaturePlan();
    const context = aContext();
    const { run, agent } = setup({ turn: { output: plan } });

    expect(await run(planFeature, aRunState({ context }))).toEqual({
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
      aRunState({ context: aContext(), plan: aFeaturePlan() }),
    );

    expect(outcome).toEqual({ type: 'designWritten', docs });
  });

  it('slices the plan document', async () => {
    const slices = [aPlannedSlice(), aPlannedSlice()];
    const docs = designDocs();
    const { run, agent } = setup({ turn: { output: slices } });

    expect(await run(sliceThePlan, aRunState({ docs }))).toEqual({ type: 'sliced', slices });
    expect(agent.calls[0].prompt).toContain(docs.plan);
  });

  it('rejects a slice plan that repeats an id', async () => {
    const repeated = aPlannedSlice();
    const { run } = setup({ turn: { output: [repeated, aPlannedSlice({ id: repeated.id })] } });

    await expect(run(sliceThePlan, aRunState({ docs: designDocs() }))).rejects.toThrow(
      new AgentOutputInvalid(`The slice plan repeats slice ids: ${repeated.id}`),
    );
  });

  it('rejects a slice plan with no slices or with an unsafe id', async () => {
    const empty = setup({ turn: { output: [] } });
    const unsafe = setup({
      turn: { output: [aPlannedSlice({ id: `${faker.word.noun()} ${faker.word.noun()}` })] },
    });

    await expect(empty.run(sliceThePlan, aRunState({ docs: designDocs() }))).rejects.toBeInstanceOf(
      AgentOutputInvalid,
    );
    await expect(
      unsafe.run(sliceThePlan, aRunState({ docs: designDocs() })),
    ).rejects.toBeInstanceOf(AgentOutputInvalid);
  });

  it('pauses for a person after planning only when the design gate is a checkpoint', async () => {
    const checkpoint = setup({ settings: runSettings({ designGate: 'checkpoint' }) });
    const automatic = setup({ settings: runSettings({ designGate: 'auto' }) });

    expect(await checkpoint.run(applyDesignGate, aRunState())).toEqual({ type: 'pause' });
    expect(await automatic.run(applyDesignGate, aRunState())).toEqual({ type: 'continue' });
  });

  it('refuses to plan before the context exists', async () => {
    const { run } = setup({ turn: { output: aFeaturePlan() } });

    await expect(run(planFeature, aRunState({ phase: 'planning' }))).rejects.toThrow(
      'without its context',
    );
  });

  function setup(input: { turn?: AgentScript; settings?: RunSettings }) {
    const agent = new FakeAgentSession(faker.system.directoryPath());
    if (input.turn) agent.script('planner', input.turn);
    const ports = { agent, workspace: mock<Workspace>() };
    const run = (step: RunStep, state: RunState) =>
      step({ state, ports, settings: input.settings ?? runSettings() });
    return { run, agent };
  }
});
