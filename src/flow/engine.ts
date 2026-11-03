import { panic } from 'better-result';
import pRetry from 'p-retry';

import { applyOutcome, updateCurrentSlice } from '../domain/apply-outcome.js';
import { isJigError, isTransient, messageOf, orThrow } from '../domain/errors.js';
import type { StepLocation } from '../domain/events.js';
import type { Outcome } from '../domain/outcome.js';
import type { RunId } from '../domain/run-id.js';
import {
  currentSlice,
  enterPhase,
  type RunPhase,
  type RunState,
  type RunStateIn,
} from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { Clock, EventSink } from '../ports/observability.js';
import type { RunStore } from '../ports/run-store.js';
import type {
  ForEachSliceNode,
  GuardContext,
  RunFlow,
  RunFlowNode,
  RunStep,
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

/** Where an invocation stopped; a blocked run says why. */
export type EngineResult =
  | { state: RunState; status: Exclude<EngineStatus, 'blocked'> }
  | { state: RunState; status: 'blocked'; reason: string };

export type EngineStatus = 'done' | 'stuck' | 'halted' | 'blocked';

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

  /** Every invocation that resumes a run ends it with one run-level event, a fatal error included. */
  async run(initial: RunState): Promise<EngineResult> {
    this.d.events.publish({ type: 'runResumed', runId: initial.runId, phase: initial.phase });
    let saved = initial;
    try {
      return await this.settle(initial, (state) => (saved = state));
    } catch (error) {
      this.d.events.publish({
        type: 'runFailed',
        runId: saved.runId,
        phase: saved.phase,
        reason: messageOf(error),
      });
      throw error;
    }
  }

  private async settle(
    initial: RunState,
    onSaved: (state: RunState) => void,
  ): Promise<EngineResult> {
    let state = await this.leaveHaltOrBlock(initial);
    onSaved(state);

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const passed = await this.pass(state.phase, state);
      if ('result' in passed) return passed.result;
      state = passed.state;
      orThrow(await this.d.store.save(state));
      onSaved(state);
    }
    panic(`Run ${state.runId} did not settle after ${MAX_PASSES} passes — the flow has a cycle.`);
  }

  private async leaveHaltOrBlock(state: RunState): Promise<RunState> {
    const node = this.flow[state.phase];
    const resumed: RunState = { ...state, blockedReason: undefined };
    if (!('halt' in node)) return resumed;
    const next = this.changePhase(resumed, node.resumeAt);
    orThrow(await this.d.store.save(next));
    return next;
  }

  private changePhase(state: RunState, to: RunPhase): RunState {
    if (to !== state.phase) {
      this.d.events.publish({ type: 'phaseChanged', runId: state.runId, from: state.phase, to });
    }
    return enterPhase(state, to);
  }

  /** One step of the run from `phase`; generic so the phase's step sees what `phase` guarantees. */
  private async pass<P extends RunPhase>(
    phase: P,
    state: RunStateIn<P>,
  ): Promise<{ result: EngineResult } | { state: RunState }> {
    const node: RunFlowNode<P> = this.flow[phase];
    if ('final' in node) return { result: this.finish(state, node.final) };
    if ('halt' in node) return { result: this.halt(state) };

    const attempt =
      'forEachSlice' in node
        ? await this.advanceSlices(node, state)
        : await this.advancePhase(node, state);
    if ('blockedReason' in attempt) {
      return { result: await this.block(state, attempt.blockedReason) };
    }
    return attempt;
  }

  private finish(state: RunState, final: 'done' | 'stuck'): EngineResult {
    this.d.events.publish({ type: 'runFinished', runId: state.runId, phase: state.phase });
    return { state, status: final };
  }

  private halt(state: RunState): EngineResult {
    this.d.events.publish({ type: 'runHalted', runId: state.runId, phase: state.phase });
    return { state, status: 'halted' };
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
      sliceNode.step({ state, ports: this.d.ports, settings: this.d.settings, slice }),
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
      if (!isJigError(error) || error.kind === 'fatal') throw error;
      return { blockedReason: error.message };
    }
  }

  private async timed(
    at: StepLocation,
    runId: RunId,
    step: () => Promise<Outcome>,
  ): Promise<Outcome> {
    const startedAt = this.d.clock.now();
    const elapsed = (): number => this.d.clock.now() - startedAt;
    this.d.events.publish({ type: 'stepStarted', runId, at });
    let outcome: Outcome;
    try {
      outcome = await step();
    } catch (error) {
      const reason = messageOf(error);
      this.d.events.publish({ type: 'stepFailed', runId, at, reason, durationMs: elapsed() });
      throw error;
    }
    this.d.events.publish({ type: 'stepFinished', runId, at, outcome, durationMs: elapsed() });
    return outcome;
  }

  private resolve<S extends string>(
    transitions: Transitions<S>,
    outcome: Outcome,
    context: GuardContext,
  ): S {
    const target: Target<S> | undefined = transitions[outcome.type];
    if (target === undefined) panic(`The flow has no transition for outcome "${outcome.type}"`);
    if (typeof target === 'string') return target;
    const match = target.find((entry) => !entry.when || entry.when(context));
    if (!match) panic(`The flow has no transition for outcome "${outcome.type}"`);
    return match.to;
  }

  private async advancePhase<P extends RunPhase>(
    node: StepNode<RunPhase, RunStep<P>>,
    state: RunStateIn<P>,
  ): Promise<{ state: RunState } | { blockedReason: string }> {
    const at: StepLocation = { phase: state.phase };
    const attempt = await this.attempt(at, state.runId, () =>
      node.step({ state, ports: this.d.ports, settings: this.d.settings }),
    );
    if ('blockedReason' in attempt) return attempt;

    const applied = applyOutcome(state, attempt.outcome);
    const next = this.resolve(node.on, attempt.outcome, {
      state: applied,
      settings: this.d.settings,
    });
    return { state: this.changePhase(applied, next) };
  }

  private async block(state: RunState, reason: string): Promise<EngineResult> {
    const blocked = { ...state, blockedReason: reason };
    orThrow(await this.d.store.save(blocked));
    this.d.events.publish({ type: 'runBlocked', runId: state.runId, phase: state.phase, reason });
    return { state: blocked, status: 'blocked', reason };
  }
}

/** A guard against a flow that never settles; every healthy pass moves a phase or a slice forward. */
const MAX_PASSES = 1000;
