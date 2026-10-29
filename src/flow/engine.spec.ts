import { faker } from '@faker-js/faker';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import {
  AgentOutputInvalid,
  AgentRunFailed,
  ConfigInvalid,
  MergeFailed,
} from '../domain/errors.js';
import type { Outcome } from '../domain/outcome.js';
import type { RunPhase, RunState } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { AgentSession } from '../ports/agent-session.js';
import type { Workspace } from '../ports/workspace.js';
import {
  anImplementation,
  aContext,
  aFeaturePlan,
  aRunState,
  aSlice,
  runSettings,
} from '../../tests/support/builders.js';
import { InMemoryRunStore, RecordingEventSink, SteppingClock } from '../../tests/support/fakes.js';
import {
  defineRunFlow,
  defineSliceFlow,
  type RunFlow,
  type RunStep,
  type SliceFlow,
  type SliceStep,
} from './define-flow.js';
import { runEngine } from './engine.js';

describe('runEngine', () => {
  it('walks phases by the outcome each step returns and finishes done', async () => {
    const context = aContext();
    const plan = aFeaturePlan();
    const { run } = setup({
      flow: linearFlow({
        context: async () => ({ type: 'contextBuilt', context }),
        planning: async () => ({ type: 'featurePlanned', plan }),
      }),
    });

    const { state, status } = await run(aRunState({ phase: 'context' }));

    expect(status).toBe('done');
    expect(state).toMatchObject({ phase: 'done', context, plan });
  });

  it('saves state after every transition so a later invocation can resume from it', async () => {
    const { run, store } = setup({
      flow: linearFlow({
        context: async () => ({ type: 'contextBuilt', context: aContext() }),
        planning: async () => ({ type: 'featurePlanned', plan: aFeaturePlan() }),
      }),
    });

    await run(aRunState({ phase: 'context' }));

    expect(store.saved.map((saved) => saved.phase)).toEqual(['planning', 'done']);
  });

  it('starts from the saved phase without re-running earlier steps', async () => {
    const buildContext = vi.fn<RunStep>();
    const { run } = setup({
      flow: linearFlow({
        context: buildContext,
        planning: async () => ({ type: 'featurePlanned', plan: aFeaturePlan() }),
      }),
    });

    await run(aRunState({ phase: 'planning', context: aContext() }));

    expect(buildContext).not.toHaveBeenCalled();
  });

  it('stops at a halt and carries on from its resume phase on the next invocation', async () => {
    const afterHalt = vi.fn<RunStep>(async () => ({
      type: 'featurePlanned',
      plan: aFeaturePlan(),
    }));
    const { run } = setup({
      flow: haltingFlow({ beforeHalt: async () => ({ type: 'pause' }), afterHalt }),
    });

    const first = await run(aRunState({ phase: 'gate' }));
    expect(first.status).toBe('halted');
    expect(first.state.phase).toBe('paused');
    expect(afterHalt).not.toHaveBeenCalled();

    const second = await run(first.state);
    expect(second.status).toBe('done');
    expect(afterHalt).toHaveBeenCalledOnce();
  });

  it('retries a step that failed transiently, up to the configured number of retries', async () => {
    const plan = aFeaturePlan();
    const failures = faker.number.int({ min: 1, max: 3 });
    let calls = 0;
    const { run, events } = setup({
      settings: runSettings({ maxStepRetries: failures }),
      flow: linearFlow({
        context: async () => ({ type: 'contextBuilt', context: aContext() }),
        planning: async () => {
          calls++;
          if (calls <= failures) throw new AgentRunFailed(faker.lorem.sentence());
          return { type: 'featurePlanned', plan };
        },
      }),
    });

    const { status, state } = await run(aRunState({ phase: 'planning' }));

    expect(status).toBe('done');
    expect(state.plan).toEqual(plan);
    expect(events.ofType('stepRetried')).toHaveLength(failures);
  });

  it('blocks once retries run out, keeping the phase so the step runs again on resume', async () => {
    const reason = faker.lorem.sentence();
    const { run, store } = setup({
      settings: runSettings({ maxStepRetries: 1 }),
      flow: linearFlow({
        context: async () => {
          throw new AgentRunFailed(reason);
        },
      }),
    });

    const { status, state } = await run(aRunState({ phase: 'context' }));

    expect(status).toBe('blocked');
    expect(state).toMatchObject({ phase: 'context', blockedReason: reason });
    expect(await store.load(state.runId)).toMatchObject({ blockedReason: reason });
  });

  it('clears the blocked reason when a blocked run is resumed', async () => {
    const { run } = setup({
      flow: linearFlow({ context: async () => ({ type: 'contextBuilt', context: aContext() }) }),
    });

    const { state } = await run(
      aRunState({ phase: 'context', blockedReason: faker.lorem.sentence() }),
    );

    expect(state.blockedReason).toBeUndefined();
  });

  it('blocks straight away on a failure that needs a person', async () => {
    const reason = faker.lorem.sentence();
    const merge = vi.fn<RunStep>(async () => {
      throw new MergeFailed(reason);
    });
    const { run } = setup({
      settings: runSettings({ maxStepRetries: 3 }),
      flow: linearFlow({ context: merge }),
    });

    const { status, state } = await run(aRunState({ phase: 'context' }));

    expect(status).toBe('blocked');
    expect(state.blockedReason).toBe(reason);
    expect(merge).toHaveBeenCalledOnce();
  });

  it('aborts on a fatal failure', async () => {
    const failure = new ConfigInvalid(faker.lorem.sentence());
    const { run } = setup({
      flow: linearFlow({
        context: async () => {
          throw failure;
        },
      }),
    });

    await expect(run(aRunState({ phase: 'context' }))).rejects.toBe(failure);
  });

  it('retries invalid agent output and then blocks, even where the flow accepts a change request', async () => {
    const reason = faker.lorem.sentence();
    const maxStepRetries = faker.number.int({ min: 0, max: 3 });
    const review = vi.fn<SliceStep>(async () => {
      throw new AgentOutputInvalid(reason);
    });
    const { run } = setup({
      flow: sliceOnlyFlow({
        pending: async () => anImplementation(),
        in_review: review,
      }),
      settings: runSettings({ maxStepRetries }),
    });

    const { status, state } = await run(
      aRunState({ phase: 'slices', slices: [aSlice({ status: 'pending', reviewCycles: 0 })] }),
    );

    expect(status).toBe('blocked');
    expect(state.blockedReason).toBe(reason);
    expect(state.slices[0]).toMatchObject({ status: 'in_review', reviewCycles: 0 });
    expect(review).toHaveBeenCalledTimes(maxStepRetries + 1);
  });

  it('works through slices in order and moves on once every slice is approved', async () => {
    const implemented: string[] = [];
    const first = aSlice({ order: 0 });
    const second = aSlice({ order: 1 });
    const { run } = setup({
      flow: sliceOnlyFlow({
        pending: async ({ slice }) => {
          implemented.push(slice.id);
          return anImplementation();
        },
        in_review: async () => ({ type: 'approved' }),
      }),
    });

    const { status, state } = await run(aRunState({ phase: 'slices', slices: [second, first] }));

    expect(status).toBe('done');
    expect(implemented).toEqual([first.id, second.id]);
    expect(state.slices.every((slice) => slice.status === 'approved')).toBe(true);
  });

  it('follows the first guarded transition whose condition holds', async () => {
    const reviews: Outcome[] = [
      { type: 'changesRequested', feedback: faker.lorem.sentence() },
      { type: 'approved' },
    ];
    const { run } = setup({
      flow: sliceOnlyFlow({
        pending: async () => anImplementation(),
        in_review: async () => reviews.shift() as Outcome,
      }),
      settings: runSettings({ reviewCycleCap: 2 }),
    });

    const { state } = await run(
      aRunState({ phase: 'slices', slices: [aSlice({ status: 'pending' })] }),
    );

    expect(state.slices[0]).toMatchObject({ status: 'approved', reviewCycles: 1 });
  });

  it('ends the run stuck when a slice gets stuck', async () => {
    const feedback = faker.lorem.sentence();
    const { run } = setup({
      flow: sliceOnlyFlow({
        pending: async () => anImplementation(),
        in_review: async () => ({ type: 'changesRequested', feedback }),
      }),
      settings: runSettings({ reviewCycleCap: 1 }),
    });

    const { status, state } = await run(
      aRunState({ phase: 'slices', slices: [aSlice({ status: 'pending' })] }),
    );

    expect(status).toBe('stuck');
    expect(state.phase).toBe('stuck');
  });

  it('reports how long each step took', async () => {
    const { run, events } = setup({
      flow: linearFlow({ context: async () => ({ type: 'contextBuilt', context: aContext() }) }),
    });

    await run(aRunState({ phase: 'context' }));

    expect(events.ofType('stepFinished')[0]).toMatchObject({
      outcome: { type: 'contextBuilt' },
      durationMs: 10,
    });
  });

  it('refuses an outcome the flow has no transition for', async () => {
    const { run } = setup({ flow: linearFlow({ context: async () => ({ type: 'pause' }) }) });

    await expect(run(aRunState({ phase: 'context' }))).rejects.toThrow(
      'no transition for outcome "pause"',
    );
  });

  function setup(input: { flow: RunFlow; settings?: RunSettings }) {
    const store = new InMemoryRunStore();
    const events = new RecordingEventSink();
    const dependencies = {
      ports: { agent: mock<AgentSession>(), workspace: mock<Workspace>() },
      store,
      events,
      clock: new SteppingClock(),
      settings: input.settings ?? runSettings(),
    };
    const run = (state: RunState) => runEngine(input.flow, state, dependencies);
    return { run, store, events };
  }
});

const unused: RunStep = async () => {
  throw new Error('This phase is not part of the test flow');
};

function flowWith(nodes: Partial<RunFlow>): RunFlow {
  const filler = { step: unused, on: {} };
  const phases: RunPhase[] = [
    'context',
    'planning',
    'designing',
    'slicing',
    'gate',
    'paused',
    'slices',
    'describing',
    'merging',
    'awaitingMerge',
    'done',
    'stuck',
  ];
  return defineRunFlow({
    ...(Object.fromEntries(phases.map((phase) => [phase, filler])) as RunFlow),
    done: { final: 'done' },
    stuck: { final: 'stuck' },
    ...nodes,
  });
}

function linearFlow(steps: { context: RunStep; planning?: RunStep }) {
  return flowWith({
    context: { step: steps.context, on: { contextBuilt: steps.planning ? 'planning' : 'done' } },
    planning: { step: steps.planning ?? unused, on: { featurePlanned: 'done' } },
  });
}

function haltingFlow(steps: { beforeHalt: RunStep; afterHalt: RunStep }) {
  return flowWith({
    gate: { step: steps.beforeHalt, on: { pause: 'paused' } },
    paused: { halt: true, resumeAt: 'planning' },
    planning: { step: steps.afterHalt, on: { featurePlanned: 'done' } },
  });
}

function sliceOnlyFlow(steps: { pending: SliceStep; in_review: SliceStep }) {
  const backToPendingUnlessCapped = [
    {
      to: 'stuck',
      when: ({ slice, settings }: { slice?: { reviewCycles: number }; settings: RunSettings }) =>
        (slice?.reviewCycles ?? 0) >= settings.reviewCycleCap,
    },
    { to: 'pending' },
  ] as const;
  const slices: SliceFlow = defineSliceFlow({
    pending: { step: steps.pending, on: { implemented: 'in_review' } },
    in_review: {
      step: steps.in_review,
      on: { approved: 'approved', changesRequested: backToPendingUnlessCapped },
    },
    verifying: { step: unused, on: {} },
    approved: { final: 'done' },
    stuck: { final: 'stuck' },
  });
  return flowWith({
    slices: { forEachSlice: slices, on: { allApproved: 'done', sliceStuck: 'stuck' } },
  });
}
