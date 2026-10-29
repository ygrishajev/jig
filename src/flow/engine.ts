import pRetry from 'p-retry';
import { applyOutcome, updateCurrentSlice } from '../domain/apply-outcome.js';
import { SdlcError } from '../domain/errors.js';
import type { StepLocation } from '../domain/events.js';
import type { Outcome } from '../domain/outcome.js';
import type { RunId } from '../domain/run-id.js';
import { currentSlice, type RunPhase, type RunState } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { Clock, EventSink } from '../ports/observability.js';
import type { RunStore } from '../ports/run-store.js';
import type {
  ForEachSliceNode,
  GuardContext,
  RunFlow,
  RunStepContext,
  StepNode,
  StepPorts,
  Target,
  Transitions,
} from './define-flow.js';

export interface EngineDependencies {
  ports: StepPorts;
  store: RunStore;
  events: EventSink;
  clock: Clock;
  settings: RunSettings;
}

export type EngineStatus = 'done' | 'stuck' | 'halted' | 'blocked';

export interface EngineResult {
  state: RunState;
  status: EngineStatus;
}

/** A guard against a flow that never settles; every healthy pass moves a phase or a slice forward. */
const MAX_PASSES = 1000;

type Attempt = { outcome: Outcome } | { blockedReason: string };

/** Drives a run through `flow` from its saved phase until it finishes, halts, or blocks. */
export async function runEngine(
  flow: RunFlow,
  initial: RunState,
  dependencies: EngineDependencies,
): Promise<EngineResult> {
  const engine = new Engine(flow, dependencies);
  return engine.run(initial);
}

class Engine {
  constructor(
    private readonly flow: RunFlow,
    private readonly d: EngineDependencies,
  ) {}

  async run(initial: RunState): Promise<EngineResult> {
    this.d.events.publish({ type: 'runResumed', runId: initial.runId, phase: initial.phase });
    let state = await this.leaveHaltOrBlock(initial);

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const node = this.flow[state.phase];
      if ('final' in node) return this.finish(state, node.final);
      if ('halt' in node) return this.halt(state);

      const attempt =
        'forEachSlice' in node
          ? await this.advanceSlices(node, state)
          : await this.advancePhase(node, state);
      if ('blockedReason' in attempt) return this.block(state, attempt.blockedReason);

      state = attempt.state;
      await this.d.store.save(state);
    }
    throw new Error(
      `Run ${state.runId} did not settle after ${MAX_PASSES} passes — the flow has a cycle.`,
    );
  }

  private async leaveHaltOrBlock(state: RunState) {
    const node = this.flow[state.phase];
    const resumed: RunState = { ...state, blockedReason: undefined };
    if (!('halt' in node)) return resumed;
    const next = this.changePhase(resumed, node.resumeAt);
    await this.d.store.save(next);
    return next;
  }

  private async advancePhase(
    node: StepNode<RunPhase, (context: RunStepContext) => Promise<Outcome>>,
    state: RunState,
  ): Promise<{ state: RunState } | { blockedReason: string }> {
    const at: StepLocation = { phase: state.phase };
    const attempt = await this.attempt(at, state.runId, () => node.step(this.stepContext(state)));
    if ('blockedReason' in attempt) return attempt;

    const applied = applyOutcome(state, attempt.outcome);
    const next = this.resolve(node.on, attempt.outcome, {
      state: applied,
      settings: this.d.settings,
    });
    return { state: this.changePhase(applied, next) };
  }

  private async advanceSlices(
    node: ForEachSliceNode<RunPhase>,
    state: RunState,
  ): Promise<{ state: RunState } | { blockedReason: string }> {
    const slice = currentSlice(state);
    if (!slice) return { state: this.changePhase(state, node.on.allApproved) };

    const sliceNode = node.forEachSlice[slice.status];
    if ('final' in sliceNode) return { state: this.changePhase(state, node.on.sliceStuck) };

    const at: StepLocation = { phase: state.phase, sliceId: slice.id, sliceStatus: slice.status };
    const attempt = await this.attempt(at, state.runId, () =>
      sliceNode.step({ ...this.stepContext(state), slice }),
    );
    if ('blockedReason' in attempt) return attempt;

    const applied = applyOutcome(state, attempt.outcome);
    const nextStatus = this.resolve(sliceNode.on, attempt.outcome, {
      state: applied,
      slice: currentSlice(applied),
      settings: this.d.settings,
    });
    this.d.events.publish({
      type: 'sliceStatusChanged',
      runId: state.runId,
      sliceId: slice.id,
      from: slice.status,
      to: nextStatus,
    });
    return {
      state: updateCurrentSlice(applied, (current) => ({ ...current, status: nextStatus })),
    };
  }

  /**
   * Runs a step under the failure policy: `retry` failures are retried up to `maxStepRetries`
   * and then block the run, `block` failures block it straight away, and anything else propagates.
   */
  private async attempt(
    at: StepLocation,
    runId: RunId,
    step: () => Promise<Outcome>,
  ): Promise<Attempt> {
    try {
      const outcome = await pRetry(() => this.timed(at, runId, step), {
        retries: this.d.settings.maxStepRetries,
        minTimeout: this.d.settings.retryDelayMs,
        shouldRetry: ({ error }) => isTransient(error),
        onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
          if (!isTransient(error) || retriesLeft === 0) return;
          this.d.events.publish({
            type: 'stepRetried',
            runId,
            at,
            attempt: attemptNumber,
            reason: error.message,
          });
        },
      });
      return { outcome };
    } catch (error) {
      if (!(error instanceof SdlcError) || error.kind === 'fatal') throw error;
      return { blockedReason: error.message };
    }
  }

  private async timed(at: StepLocation, runId: RunId, step: () => Promise<Outcome>) {
    const startedAt = this.d.clock.now();
    this.d.events.publish({ type: 'stepStarted', runId, at });
    const outcome = await step();
    const durationMs = this.d.clock.now() - startedAt;
    this.d.events.publish({ type: 'stepFinished', runId, at, outcome, durationMs });
    return outcome;
  }

  private resolve<S extends string>(
    transitions: Transitions<S>,
    outcome: Outcome,
    context: GuardContext,
  ): S {
    const target: Target<S> | undefined = transitions[outcome.type];
    if (target === undefined) {
      throw new Error(`The flow has no transition for outcome "${outcome.type}"`);
    }
    if (typeof target === 'string') return target;
    const match = target.find((entry) => !entry.when || entry.when(context));
    if (!match) throw new Error(`No guarded transition matched outcome "${outcome.type}"`);
    return match.to;
  }

  private stepContext(state: RunState): RunStepContext {
    return { state, ports: this.d.ports, settings: this.d.settings };
  }

  private changePhase(state: RunState, to: RunPhase): RunState {
    if (to !== state.phase) {
      this.d.events.publish({ type: 'phaseChanged', runId: state.runId, from: state.phase, to });
    }
    return { ...state, phase: to };
  }

  private finish(state: RunState, final: 'done' | 'stuck'): EngineResult {
    this.d.events.publish({ type: 'runFinished', runId: state.runId, phase: state.phase });
    return { state, status: final };
  }

  private halt(state: RunState): EngineResult {
    this.d.events.publish({ type: 'runHalted', runId: state.runId, phase: state.phase });
    return { state, status: 'halted' };
  }

  private async block(state: RunState, reason: string): Promise<EngineResult> {
    const blocked = { ...state, blockedReason: reason };
    await this.d.store.save(blocked);
    this.d.events.publish({ type: 'runBlocked', runId: state.runId, phase: state.phase, reason });
    return { state: blocked, status: 'blocked' };
  }
}

function isTransient(error: unknown) {
  return error instanceof SdlcError && error.kind === 'retry';
}
