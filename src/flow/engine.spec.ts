import { faker } from '@faker-js/faker';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { Panic, panic, Result } from 'better-result';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  aContext,
  aFeaturePlan,
  anImplementation,
  aRunState,
  aSlice,
  designDocs,
  runSettings,
} from '../../tests/support/builders.js';
import { InMemoryRunStore, RecordingEventSink, SteppingClock } from '../../tests/support/fakes.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { DesignUnresolved, PlanNotCovered } from '../domain/errors.js';
import type { Outcome } from '../domain/outcome.js';
import { type RunState } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import { RunEvents } from '../observers/run-events.js';
import { TracingObserver } from '../observers/tracing-observer.js';
import {
  AgentOutputInvalid,
  AgentRunFailed,
  type AgentSession,
  SandboxUnavailable,
} from '../ports/agent-session.js';
import { GitCommandFailed, RemoteUnavailable } from '../ports/git-failures.js';
import { LocalStateUnwritable } from '../ports/local-state.js';
import type { EventSink } from '../ports/observability.js';
import { RunStateConflict } from '../ports/run-state-failures.js';
import type { RunStore, RunStoreFailure } from '../ports/run-store.js';
import {
  CommitImportRefused,
  CommitRejected,
  MergeFailed,
  type Workspace,
} from '../ports/workspace.js';
import {
  defineRunFlow,
  defineSliceFlow,
  type FatalStepFailure,
  type RunFlow,
  type RunStep,
  type SliceFlow,
  type SliceStep,
  type StepFailure,
} from './define-flow.js';
import { type EngineFailure, runEngine } from './engine.js';

describe('runEngine', () => {
  it('walks phases by the outcome each step returns and finishes done', async () => {
    const context = aContext();
    const plan = aFeaturePlan();
    const { settle } = setup({
      flow: linearFlow({
        context: async () => Result.ok({ type: 'contextBuilt', context }),
        planning: async () => Result.ok({ type: 'featurePlanned', plan }),
      }),
    });

    const { state, status } = await settle(aDescribedRun({ phase: 'context' }));

    expect(status).toBe('done');
    expect(state).toMatchObject({ phase: 'done', context, plan });
  });

  it('saves state after every transition so a later invocation can resume from it', async () => {
    const { settle, store } = setup({
      flow: linearFlow({
        context: async () => Result.ok({ type: 'contextBuilt', context: aContext() }),
        planning: async () => Result.ok({ type: 'featurePlanned', plan: aFeaturePlan() }),
      }),
    });

    await settle(aDescribedRun({ phase: 'context' }));

    expect(store.saved.map((saved) => saved.phase)).toEqual(['planning', 'done']);
  });

  it('starts from the saved phase without re-running earlier steps', async () => {
    const context = aContext();
    const plan = aFeaturePlan();
    const { settle, events } = setup({
      flow: linearFlow({
        context: async () => Result.ok({ type: 'contextBuilt', context: aContext() }),
        planning: async () => Result.ok({ type: 'featurePlanned', plan }),
      }),
    });

    const { status, state } = await settle(aDescribedRun({ phase: 'planning', context }));

    expect(status).toBe('done');
    expect(state).toMatchObject({ phase: 'done', context, plan });
    expect(events.ofType('stepStarted').map((event) => event.at)).toEqual([{ phase: 'planning' }]);
  });

  it('stops at a halt and carries on from its resume phase on the next invocation', async () => {
    const plan = aFeaturePlan();
    const { settle, store } = setup({
      flow: haltingFlow({
        beforeHalt: async () => Result.ok({ type: 'pause' }),
        afterHalt: async () => Result.ok({ type: 'featurePlanned', plan }),
      }),
    });
    const initial = aDescribedRun({ phase: 'gate' });

    const first = await settle(initial);
    expect(first).toMatchObject({ status: 'halted', state: { phase: 'paused' } });
    expect(first.state.plan).toEqual(initial.plan);

    const second = await settle(first.state);
    expect(second).toMatchObject({ status: 'done', state: { phase: 'done', plan } });
    expect(store.saved.map((saved) => saved.phase)).toEqual(['paused', 'planning', 'done']);
  });

  it('retries a step that failed transiently, up to the configured number of retries', async () => {
    const plan = aFeaturePlan();
    const failures = faker.number.int({ min: 1, max: 3 });
    let calls = 0;
    const { settle, events } = setup({
      settings: runSettings({ maxStepRetries: failures }),
      flow: linearFlow({
        context: async () => Result.ok({ type: 'contextBuilt', context: aContext() }),
        planning: async () => {
          calls++;
          if (calls <= failures) {
            return Result.err(new AgentRunFailed({ message: faker.lorem.sentence() }));
          }
          return Result.ok({ type: 'featurePlanned', plan });
        },
      }),
    });

    const { status, state } = await settle(aDescribedRun({ phase: 'planning' }));

    expect(status).toBe('done');
    expect(state.plan).toEqual(plan);
    expect(events.ofType('stepRetried')).toHaveLength(failures);
  });

  it('reports every failed attempt, so each started step is seen to end', async () => {
    const reason = faker.lorem.sentence();
    const retries = faker.number.int({ min: 0, max: 3 });
    const { settle, events } = setup({
      settings: runSettings({ maxStepRetries: retries }),
      flow: linearFlow({
        context: async () => Result.err(new AgentRunFailed({ message: reason })),
      }),
    });

    await settle(aDescribedRun({ phase: 'context' }));

    expect(events.ofType('stepStarted')).toHaveLength(retries + 1);
    expect(events.ofType('stepFailed')).toHaveLength(retries + 1);
    expect(events.ofType('stepFailed')[retries]).toMatchObject({
      at: { phase: 'context' },
      reason,
    });
    expect(events.ofType('stepRetried').map((event) => event.attempt)).toEqual(
      Array.from({ length: retries }, (_, index) => index + 1),
    );
  });

  it('reports a run from resuming through each phase change to its finish', async () => {
    const { settle, events } = setup({
      flow: linearFlow({
        context: async () => Result.ok({ type: 'contextBuilt', context: aContext() }),
        planning: async () => Result.ok({ type: 'featurePlanned', plan: aFeaturePlan() }),
      }),
    });
    const initial = aDescribedRun({ phase: 'context' });
    const { runId } = initial;

    await settle(initial);

    expect(events.events.map((event) => event.type)).toEqual([
      'runResumed',
      'stepStarted',
      'stepFinished',
      'phaseChanged',
      'stepStarted',
      'stepFinished',
      'phaseChanged',
      'runFinished',
    ]);
    expect(events.ofType('runResumed')).toEqual([{ type: 'runResumed', runId, phase: 'context' }]);
    expect(events.ofType('phaseChanged')).toEqual([
      { type: 'phaseChanged', runId, from: 'context', to: 'planning' },
      { type: 'phaseChanged', runId, from: 'planning', to: 'done' },
    ]);
    expect(events.ofType('runFinished')).toEqual([{ type: 'runFinished', runId, phase: 'done' }]);
  });

  it('finishes a run that reaches a completed final node as completed', async () => {
    const { settle, events } = setup({
      flow: flowWith({
        context: {
          step: async () => Result.ok({ type: 'contextBuilt', context: aContext() }),
          on: { contextBuilt: 'completed' },
        },
      }),
    });
    const initial = aDescribedRun({ phase: 'context' });

    const result = await settle(initial);

    expect(result.status).toBe('completed');
    expect(events.ofType('runFinished')).toEqual([
      { type: 'runFinished', runId: initial.runId, phase: 'completed' },
    ]);
  });

  it('reports a run that stops at a halt or blocks, with where and why', async () => {
    const reason = faker.lorem.sentence();
    const halting = setup({
      flow: haltingFlow({
        beforeHalt: async () => Result.ok({ type: 'pause' }),
        afterHalt: unused,
      }),
    });
    const blocking = setup({
      settings: runSettings({ maxStepRetries: 0 }),
      flow: linearFlow({
        context: async () => Result.err(new MergeFailed({ message: reason })),
      }),
    });
    const halted = aDescribedRun({ phase: 'gate' });
    const blocked = aDescribedRun({ phase: 'context' });

    await halting.settle(halted);
    await blocking.settle(blocked);

    expect(halting.events.ofType('runHalted')).toEqual([
      { type: 'runHalted', runId: halted.runId, phase: 'paused' },
    ]);
    expect(blocking.events.ofType('runBlocked')).toEqual([
      { type: 'runBlocked', runId: blocked.runId, phase: 'context', reason },
    ]);
  });

  it('reports each slice moving from one status to the next', async () => {
    const slice = aSlice({ status: 'pending' });
    const { settle, events } = setup({
      flow: sliceOnlyFlow({
        pending: async () => Result.ok(anImplementation()),
        in_review: async () => Result.ok({ type: 'approved' }),
      }),
    });
    const initial = aDescribedRun({ phase: 'slices', slices: [slice] });

    await settle(initial);

    expect(events.ofType('sliceStatusChanged')).toEqual([
      {
        type: 'sliceStatusChanged',
        runId: initial.runId,
        sliceId: slice.id,
        from: 'pending',
        to: 'in_review',
      },
      {
        type: 'sliceStatusChanged',
        runId: initial.runId,
        sliceId: slice.id,
        from: 'in_review',
        to: 'approved',
      },
    ]);
  });

  it('gives up on a flow that never settles', async () => {
    const { run } = setup({
      flow: flowWith({
        context: {
          step: async () => Result.ok({ type: 'continue' }),
          on: { continue: 'planning' },
        },
        planning: {
          step: async () => Result.ok({ type: 'continue' }),
          on: { continue: 'context' },
        },
      }),
    });

    await expect(run(aDescribedRun({ phase: 'context' }))).rejects.toThrow(Panic);
  });

  it('refuses an outcome whose guarded transitions all decline', async () => {
    const { run } = setup({
      flow: flowWith({
        context: {
          step: async () => Result.ok({ type: 'contextBuilt', context: aContext() }),
          on: { contextBuilt: [{ to: 'done', when: () => false }] },
        },
      }),
    });

    await expect(run(aDescribedRun({ phase: 'context' }))).rejects.toThrow(Panic);
  });

  it('reports a bug in a step as a failed run and lets it through', async () => {
    const bug = new Error(faker.lorem.sentence());
    const { run, events } = setup({
      flow: linearFlow({
        context: async () => {
          throw bug;
        },
      }),
    });
    const initial = aDescribedRun({ phase: 'context' });

    await expect(run(initial)).rejects.toThrow(Panic);
    expect(events.ofType('stepFailed')).toMatchObject([
      { at: { phase: 'context' }, reason: bug.message },
    ]);
    expect(events.ofType('runFailed')).toEqual([
      { type: 'runFailed', runId: initial.runId, phase: 'context', reason: bug.message },
    ]);
  });

  it('reports the bug itself when a step composed with Result.gen throws', async () => {
    const bug = new Error(faker.lorem.sentence());
    const { run, events } = setup({
      flow: linearFlow({
        context: () =>
          Result.gen(async function* () {
            yield* Result.await(Promise.resolve(Result.ok()));
            throw bug;
          }),
      }),
    });

    const running = run(aDescribedRun({ phase: 'context' }));

    await expect(running).rejects.toThrow(Panic);
    await expect(running).rejects.toMatchObject({ cause: bug });
    expect(events.ofType('stepFailed')).toMatchObject([{ reason: bug.message }]);
    expect(events.ofType('runFailed')).toMatchObject([{ reason: bug.message }]);
  });

  it('reports a fatal failure as the run failing at the phase it was in', async () => {
    const reason = faker.lorem.sentence();
    const { run, events } = setup({
      flow: linearFlow({
        context: async () => Result.ok({ type: 'contextBuilt', context: aContext() }),
        planning: async () =>
          Result.err(new LocalStateUnwritable({ message: reason, path: faker.system.filePath() })),
      }),
    });
    const initial = aDescribedRun({ phase: 'context' });

    const result = await run(initial);

    expect(result.isErr() && result.error).toBeInstanceOf(LocalStateUnwritable);
    expect(events.ofType('runFailed')).toEqual([
      { type: 'runFailed', runId: initial.runId, phase: 'planning', reason },
    ]);
  });

  it('ends the trace of a run that failed fatally', async () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }).getTracer('test');
    const events = new RunEvents();
    const tracing = new TracingObserver(tracer);
    events.on('event', (event) => tracing.handle(event));
    const { run } = setup({
      events,
      flow: linearFlow({
        context: async () =>
          Result.err(
            new LocalStateUnwritable({
              message: faker.lorem.sentence(),
              path: faker.system.filePath(),
            }),
          ),
      }),
    });

    await run(aDescribedRun({ phase: 'context' }));

    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
      'jig.step context',
      'jig.run',
    ]);
  });

  it('blocks once retries run out, keeping the phase so the step runs again on resume', async () => {
    const reason = faker.lorem.sentence();
    const { settle, store } = setup({
      settings: runSettings({ maxStepRetries: 1 }),
      flow: linearFlow({
        context: async () => Result.err(new AgentRunFailed({ message: reason })),
      }),
    });

    const { status, state } = await settle(aDescribedRun({ phase: 'context' }));

    expect(status).toBe('blocked');
    expect(state).toMatchObject({ phase: 'context', blockedReason: reason });
    expect((await store.load(state.runId)).unwrap()).toMatchObject({ blockedReason: reason });
  });

  it('clears the blocked reason when a blocked run is resumed', async () => {
    const { settle, store } = setup({
      flow: linearFlow({
        context: async () => Result.ok({ type: 'contextBuilt', context: aContext() }),
      }),
    });

    const { state } = await settle(
      aDescribedRun({ phase: 'context', blockedReason: faker.lorem.sentence() }),
    );

    expect(state.blockedReason).toBeUndefined();
    expect(unwrap(await store.load(state.runId))).toMatchObject({ blockedReason: undefined });
  });

  it('tries a transient failure until the settings budget runs out', async () => {
    const maxStepRetries = faker.number.int({ min: 1, max: 3 });
    const failure = new AgentRunFailed({ message: faker.lorem.sentence() });
    const context = vi.fn<RunStep>(async () => Result.err(failure));
    const { settle } = setup({
      settings: runSettings({ maxStepRetries, retryDelayMs: 0 }),
      flow: linearFlow({ context }),
    });

    const { state } = await settle(aDescribedRun({ phase: 'context' }));

    expect(state.blockedReason).toBe(failure.message);
    expect(context).toHaveBeenCalledTimes(maxStepRetries + 1);
  });

  it('blocks straight away on a failure that needs a person', async () => {
    const reason = faker.lorem.sentence();
    const merge = vi.fn<RunStep>(async () => Result.err(new MergeFailed({ message: reason })));
    const { settle } = setup({
      settings: runSettings({ maxStepRetries: 3 }),
      flow: linearFlow({ context: merge }),
    });

    const { status, state } = await settle(aDescribedRun({ phase: 'context' }));

    expect(status).toBe('blocked');
    expect(state.blockedReason).toBe(reason);
    expect(merge).toHaveBeenCalledOnce();
  });

  it('ends the invocation on a fatal failure and says so', async () => {
    const failure = new LocalStateUnwritable({
      message: faker.lorem.sentence(),
      path: faker.system.filePath(),
    });
    const { run, events } = setup({
      settings: runSettings({ maxStepRetries: faker.number.int({ min: 1, max: 3 }) }),
      flow: linearFlow({ context: async () => Result.err(failure) }),
    });

    const result = await run(aDescribedRun({ phase: 'context' }));

    expect(result.isErr() && result.error).toBe(failure);
    expect(events.ofType('runFailed')).toHaveLength(1);
    expect(events.ofType('stepStarted')).toHaveLength(1);
  });

  it('retries a transient failure, then blocks the run with its reason', async () => {
    const reason = faker.lorem.sentence();
    const { settle, events } = setup({
      settings: runSettings({ maxStepRetries: 2 }),
      flow: linearFlow({
        context: async () => Result.err(new AgentRunFailed({ message: reason })),
      }),
    });

    const result = await settle(aDescribedRun({ phase: 'context' }));

    expect(result).toMatchObject({ status: 'blocked', reason });
    expect(events.ofType('stepRetried')).toHaveLength(2);
    expect(events.ofType('stepFailed')).toHaveLength(3);
  });

  it.each(Object.entries(reactionTo))(
    'reacts to %s as its failure calls for',
    async (_tag, expected) => {
      const step = vi.fn<RunStep>(async () => Result.err(expected.failure()));
      const { run } = setup({
        settings: runSettings({ maxStepRetries: 1 }),
        flow: linearFlow({ context: step }),
      });

      const result = await run(aDescribedRun({ phase: 'context' }));

      expect(step).toHaveBeenCalledTimes(expected.reaction === 'retries' ? 2 : 1);
      expect(result.isErr()).toBe(expected.reaction === 'aborts');
      expect(result.isOk() && result.value.status).toBe(
        expected.reaction === 'aborts' ? false : 'blocked',
      );
    },
  );

  it('returns only fatal step failures and failures saving the run', () => {
    expectTypeOf<FatalStepFailure>().toEqualTypeOf<LocalStateUnwritable>();
    expectTypeOf<EngineFailure>().toEqualTypeOf<LocalStateUnwritable | RunStoreFailure>();
  });

  it('ends the invocation when the run cannot be saved', async () => {
    const failure = new RunStateConflict({ message: faker.lorem.sentence() });
    const { run, events } = setup({
      store: mock<RunStore>({ save: async () => Result.err(failure) }),
      flow: linearFlow({
        context: async () => Result.ok({ type: 'contextBuilt', context: aContext() }),
      }),
    });

    const result = await run(aDescribedRun({ phase: 'context' }));

    expect(result.isErr() && result.error).toBe(failure);
    expect(events.ofType('runFailed')).toMatchObject([{ reason: failure.message }]);
    expect(events.ofType('runBlocked')).toEqual([]);
  });

  it('retries invalid agent output and then blocks, even where the flow accepts a change request', async () => {
    const reason = faker.lorem.sentence();
    const maxStepRetries = faker.number.int({ min: 0, max: 3 });
    const review = vi.fn<SliceStep>(async () =>
      Result.err(new AgentOutputInvalid({ message: reason })),
    );
    const { settle } = setup({
      flow: sliceOnlyFlow({
        pending: async () => Result.ok(anImplementation()),
        in_review: review,
      }),
      settings: runSettings({ maxStepRetries }),
    });

    const { status, state } = await settle(
      aDescribedRun({ phase: 'slices', slices: [aSlice({ status: 'pending', reviewCycles: 0 })] }),
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
    const { settle } = setup({
      flow: sliceOnlyFlow({
        pending: async ({ slice }) => {
          implemented.push(slice.id);
          return Result.ok(anImplementation());
        },
        in_review: async () => Result.ok({ type: 'approved' }),
      }),
    });

    const { status, state } = await settle(
      aDescribedRun({ phase: 'slices', slices: [second, first] }),
    );

    expect(status).toBe('done');
    expect(implemented).toEqual([first.id, second.id]);
    expect(state.slices.every((slice) => slice.status === 'approved')).toBe(true);
  });

  it('follows the first guarded transition whose condition holds', async () => {
    const reviews: Outcome[] = [
      { type: 'changesRequested', feedback: faker.lorem.sentence() },
      { type: 'approved' },
    ];
    const { settle } = setup({
      flow: sliceOnlyFlow({
        pending: async () => Result.ok(anImplementation()),
        in_review: async () => Result.ok(reviews.shift() ?? { type: 'approved' }),
      }),
      settings: runSettings({ reviewCycleCap: 2 }),
    });

    const { state } = await settle(
      aDescribedRun({ phase: 'slices', slices: [aSlice({ status: 'pending' })] }),
    );

    expect(state.slices[0]).toMatchObject({ status: 'approved', reviewCycles: 1 });
  });

  it('ends the run stuck when a slice gets stuck', async () => {
    const feedback = faker.lorem.sentence();
    const { settle } = setup({
      flow: sliceOnlyFlow({
        pending: async () => Result.ok(anImplementation()),
        in_review: async () => Result.ok({ type: 'changesRequested', feedback }),
      }),
      settings: runSettings({ reviewCycleCap: 1 }),
    });

    const { status, state } = await settle(
      aDescribedRun({ phase: 'slices', slices: [aSlice({ status: 'pending' })] }),
    );

    expect(status).toBe('stuck');
    expect(state.phase).toBe('stuck');
  });

  it('reports how long each step took', async () => {
    const clockStepMs = faker.number.int({ min: 1, max: 1000 });
    const { settle, events } = setup({
      clockStepMs,
      flow: linearFlow({
        context: async () => Result.ok({ type: 'contextBuilt', context: aContext() }),
      }),
    });

    await settle(aDescribedRun({ phase: 'context' }));

    expect(events.ofType('stepFinished')[0]).toMatchObject({
      outcome: { type: 'contextBuilt' },
      durationMs: clockStepMs,
    });
  });

  it('refuses to move a run into a phase whose guarantees it lacks', async () => {
    const { run } = setup({
      flow: flowWith({
        context: {
          step: async () => Result.ok({ type: 'continue' }),
          on: { continue: 'designing' },
        },
      }),
    });

    await expect(run(aRunState({ phase: 'context' }))).rejects.toThrow(Panic);
  });

  it('refuses an outcome the flow has no transition for', async () => {
    const { run } = setup({
      flow: linearFlow({ context: async () => Result.ok({ type: 'pause' }) }),
    });

    await expect(run(aDescribedRun({ phase: 'context' }))).rejects.toThrow(Panic);
  });

  function setup(input: {
    flow: RunFlow;
    settings?: RunSettings;
    events?: EventSink;
    store?: RunStore;
    clockStepMs?: number;
  }) {
    const store = new InMemoryRunStore();
    const events = new RecordingEventSink();
    const dependencies = {
      ports: { agent: mock<AgentSession>(), workspace: mock<Workspace>() },
      store: input.store ?? store,
      events: input.events ?? events,
      clock: new SteppingClock(input.clockStepMs ?? faker.number.int({ min: 1, max: 1000 })),
      settings: input.settings ?? runSettings(),
    };
    const run = (state: RunState) => runEngine(input.flow, state, dependencies);
    const settle = async (state: RunState) => (await run(state)).unwrap();
    return { run, settle, store, events };
  }
});

/** Every failure a step can return; one left out, or no longer a step failure, does not compile. */
const reactionTo: {
  [Failure in StepFailure as Failure['_tag']]: {
    reaction: 'retries' | 'blocks' | 'aborts';
    failure: () => Failure;
  };
} = {
  AgentRunFailed: { reaction: 'retries', failure: () => new AgentRunFailed(aMessage()) },
  AgentOutputInvalid: { reaction: 'retries', failure: () => new AgentOutputInvalid(aMessage()) },
  SandboxUnavailable: { reaction: 'retries', failure: () => new SandboxUnavailable(aMessage()) },
  RemoteUnavailable: { reaction: 'retries', failure: () => new RemoteUnavailable(aMessage()) },
  PlanNotCovered: { reaction: 'retries', failure: () => new PlanNotCovered(aMessage()) },
  DesignUnresolved: {
    reaction: 'blocks',
    failure: () => new DesignUnresolved({ ...aMessage(), findingIds: [faker.lorem.slug()] }),
  },
  MergeFailed: { reaction: 'blocks', failure: () => new MergeFailed(aMessage()) },
  CommitImportRefused: { reaction: 'blocks', failure: () => new CommitImportRefused(aMessage()) },
  CommitRejected: {
    reaction: 'blocks',
    failure: () => new CommitRejected({ ...aMessage(), output: faker.lorem.sentence() }),
  },
  GitCommandFailed: {
    reaction: 'blocks',
    failure: () =>
      new GitCommandFailed({
        ...aMessage(),
        command: 'git status',
        output: faker.lorem.sentence(),
      }),
  },
  LocalStateUnwritable: {
    reaction: 'aborts',
    failure: () => new LocalStateUnwritable({ ...aMessage(), path: faker.system.filePath() }),
  },
};

function aMessage() {
  return { message: faker.lorem.sentence() };
}

/**
 * The test flows jump between phases freely, so their runs carry everything every phase
 * guarantees; the real flow's order is run-flow.spec's concern.
 */
function aDescribedRun(overrides: Parameters<typeof aRunState>[0] = {}) {
  return aRunState({
    context: aContext(),
    plan: aFeaturePlan(),
    docs: designDocs(),
    prDescription: faker.lorem.paragraph(),
    ...overrides,
  });
}

const unused: RunStep = async () => panic('This phase is not part of the test flow');

function flowWith(nodes: Partial<RunFlow>): RunFlow {
  const filler = { step: unused, on: {} };
  return defineRunFlow({
    context: filler,
    planning: filler,
    designing: filler,
    reviewingDesign: filler,
    revisingDesign: filler,
    resolvingDesign: filler,
    slicing: filler,
    gate: filler,
    paused: filler,
    slices: filler,
    checkingReuse: filler,
    finalCheck: filler,
    describing: filler,
    merging: filler,
    awaitingMerge: filler,
    completed: { final: 'completed' },
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
