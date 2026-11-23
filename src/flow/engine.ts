import { panic, Result } from 'better-result';

import { applyOutcome, updateCurrentSlice } from '../domain/apply-outcome.js';
import { isTransient } from '../domain/errors.js';
import type { StepLocation } from '../domain/events.js';
import type { InvocationStatus } from '../domain/invocation-status.js';
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
import { messageOf, rootCause } from '../failures/messages.js';
import { retryResult } from '../failures/retry.js';
import type { Clock, EventSink } from '../ports/observability.js';
import type { RunStore, RunStoreFailure } from '../ports/run-store.js';
import type {
  FatalStepFailure,
  FinalOutcome,
  ForEachSliceNode,
  GuardContext,
  RunFlow,
  RunFlowNode,
  RunStep,
  StepFailure,
  StepNode,
  StepPorts,
  Target,
  Transitions,
} from './define-flow.js';
import { transientRetryPolicy } from './retry-policy.js';

export interface EngineDependencies {
  ports: StepPorts;
  store: RunStore;
  events: EventSink;
  clock: Clock;
  settings: RunSettings;
}

/** Why an invocation ended as an `Err`: a fatal step failure, or the run could not be saved. */
export type EngineFailure = FatalStepFailure | RunStoreFailure;

type Attempt = { outcome: Outcome } | { blockedReason: string };

type Pass = { result: EngineResult } | { state: RunState };

/** Where an invocation stopped; a blocked run says why. */
export type EngineResult =
  | { state: RunState; status: Exclude<InvocationStatus, 'blocked'> }
  | { state: RunState; status: 'blocked'; reason: string };

type Advance = { state: RunState } | { blockedReason: string };

/**
 * Drives a run through `flow` from its saved phase until it finishes, halts, or blocks. A `fatal`
 * failure, or one saving the run, ends the invocation as an `Err`.
 */
export async function runEngine(
  flow: RunFlow,
  initial: RunState,
  dependencies: EngineDependencies,
): Promise<Result<EngineResult, EngineFailure>> {
  const engine = new Engine(flow, dependencies);
  return engine.run(initial);
}

class Engine {
  constructor(
    private readonly flow: RunFlow,
    private readonly dependencies: EngineDependencies,
  ) {}

  /** Every invocation that resumes a run ends it with one run-level event, a failure or a bug included. */
  async run(initial: RunState): Promise<Result<EngineResult, EngineFailure>> {
    this.dependencies.events.publish({
      type: 'runResumed',
      runId: initial.runId,
      phase: initial.phase,
    });
    let saved = initial;
    let settled: Result<EngineResult, EngineFailure>;
    try {
      settled = await this.settle(initial, (state) => (saved = state));
    } catch (error) {
      const bug = rootCause(error);
      this.publishRunFailed(saved, messageOf(bug));
      panic(messageOf(bug), bug);
    }
    if (settled.isErr()) this.publishRunFailed(saved, settled.error.message);
    return settled;
  }

  private async settle(
    initial: RunState,
    onSaved: (state: RunState) => void,
  ): Promise<Result<EngineResult, EngineFailure>> {
    const resumed = await this.leaveHaltOrBlock(initial);
    if (resumed.isErr()) return resumed;
    let state = resumed.value;
    onSaved(state);

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const passed = await this.pass(state.phase, state);
      if (passed.isErr()) return passed;
      if ('result' in passed.value) return Result.ok(passed.value.result);
      state = passed.value.state;
      const saved = await this.dependencies.store.save(state);
      if (saved.isErr()) return saved;
      onSaved(state);
    }
    panic(`Run ${state.runId} did not settle after ${MAX_PASSES} passes — the flow has a cycle.`);
  }

  private async leaveHaltOrBlock(state: RunState): Promise<Result<RunState, EngineFailure>> {
    const node = this.flow[state.phase];
    const resumed: RunState = { ...state, blockedReason: undefined };
    if (!('halt' in node)) return Result.ok(resumed);
    const next = this.changePhase(resumed, node.resumeAt);
    return (await this.dependencies.store.save(next)).map(() => next);
  }

  /** `from` is where the run stood before its outcome applied, which may already have moved it. */
  private changePhase(state: RunState, to: RunPhase, from: RunPhase = state.phase): RunState {
    if (to !== from) {
      this.dependencies.events.publish({ type: 'phaseChanged', runId: state.runId, from, to });
    }
    return enterPhase(state, to);
  }

  /** One step of the run from `phase`; generic so the phase's step sees what `phase` guarantees. */
  private async pass<P extends RunPhase>(
    phase: P,
    state: RunStateIn<P>,
  ): Promise<Result<Pass, EngineFailure>> {
    const node: RunFlowNode<P> = this.flow[phase];
    if ('final' in node) return Result.ok({ result: this.finish(state, node.final) });
    if ('halt' in node) return Result.ok({ result: this.halt(state) });

    const advanced =
      'forEachSlice' in node
        ? await this.advanceSlices(node, state)
        : await this.advancePhase(node, state);
    if (advanced.isErr()) return advanced;
    if (!('blockedReason' in advanced.value)) return Result.ok(advanced.value);
    return (await this.block(state, advanced.value.blockedReason)).map((result) => ({ result }));
  }

  private finish(state: RunState, final: FinalOutcome): EngineResult {
    this.dependencies.events.publish({
      type: 'runFinished',
      runId: state.runId,
      phase: state.phase,
    });
    return { state, status: final };
  }

  private halt(state: RunState): EngineResult {
    this.dependencies.events.publish({ type: 'runHalted', runId: state.runId, phase: state.phase });
    return { state, status: 'halted' };
  }

  private async advanceSlices(
    node: ForEachSliceNode<RunPhase>,
    state: RunState,
  ): Promise<Result<Advance, EngineFailure>> {
    const slice = currentSlice(state);
    if (!slice) return Result.ok({ state: this.changePhase(state, node.on.allApproved) });

    const sliceNode = node.forEachSlice[slice.status];
    if ('final' in sliceNode) {
      return Result.ok({ state: this.changePhase(state, node.on.sliceStuck) });
    }

    const at: StepLocation = { phase: state.phase, sliceId: slice.id, sliceStatus: slice.status };
    const attempted = await this.attempt(at, state.runId, () =>
      sliceNode.step({
        state,
        ports: this.dependencies.ports,
        settings: this.dependencies.settings,
        slice,
      }),
    );
    if (attempted.isErr()) return attempted;
    if ('blockedReason' in attempted.value) return Result.ok(attempted.value);

    const { outcome } = attempted.value;
    const applied = applyOutcome(state, outcome);
    const nextStatus = this.resolve(sliceNode.on, outcome, {
      state: applied,
      slice: currentSlice(applied),
      settings: this.dependencies.settings,
    });
    this.dependencies.events.publish({
      type: 'sliceStatusChanged',
      runId: state.runId,
      sliceId: slice.id,
      from: slice.status,
      to: nextStatus,
    });
    return Result.ok({
      state: updateCurrentSlice(applied, (current) => ({ ...current, status: nextStatus })),
    });
  }

  /**
   * Runs a step under the failure policy: `retry` failures are retried up to `maxStepRetries`
   * and then block the run, `block` failures block it straight away, and `fatal` ones are returned.
   */
  private async attempt(
    at: StepLocation,
    runId: RunId,
    step: () => Promise<Result<Outcome, StepFailure>>,
  ): Promise<Result<Attempt, FatalStepFailure>> {
    const attempted = await retryResult<Outcome, StepFailure>(() => this.timed(at, runId, step), {
      ...transientRetryPolicy(this.dependencies.settings),
      onFailedAttempt: ({ error, attempt, retriesLeft }) => {
        if (!isTransient(error) || retriesLeft === 0) return;
        this.dependencies.events.publish({
          type: 'stepRetried',
          runId,
          at,
          attempt,
          reason: error.message,
        });
      },
    });
    if (attempted.isOk()) return Result.ok({ outcome: attempted.value });
    if (attempted.error.kind === 'fatal') return Result.err(attempted.error);
    return Result.ok({ blockedReason: attempted.error.message });
  }

  /** A step that throws is a bug; its attempt is still reported as failed before it goes on up. */
  private async timed(
    at: StepLocation,
    runId: RunId,
    step: () => Promise<Result<Outcome, StepFailure>>,
  ): Promise<Result<Outcome, StepFailure>> {
    const startedAt = this.dependencies.clock.now();
    const elapsed = (): number => this.dependencies.clock.now() - startedAt;
    const publishFailed = (reason: string): void =>
      this.dependencies.events.publish({
        type: 'stepFailed',
        runId,
        at,
        reason,
        durationMs: elapsed(),
      });
    this.dependencies.events.publish({ type: 'stepStarted', runId, at });
    let stepped: Result<Outcome, StepFailure>;
    try {
      stepped = await step();
    } catch (error) {
      const bug = rootCause(error);
      publishFailed(messageOf(bug));
      panic(messageOf(bug), bug);
    }
    if (stepped.isErr()) {
      publishFailed(stepped.error.message);
      return stepped;
    }
    const outcome = stepped.value;
    this.dependencies.events.publish({
      type: 'stepFinished',
      runId,
      at,
      outcome,
      durationMs: elapsed(),
    });
    return stepped;
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
  ): Promise<Result<Advance, EngineFailure>> {
    return Result.gen(async function* (this: Engine) {
      const at: StepLocation = { phase: state.phase };
      const attempted = yield* Result.await(
        this.attempt(at, state.runId, () =>
          node.step({
            state,
            ports: this.dependencies.ports,
            settings: this.dependencies.settings,
          }),
        ),
      );
      if ('blockedReason' in attempted) return Result.ok(attempted);

      const { outcome } = attempted;
      const applied = applyOutcome(state, outcome);
      const next = this.resolve(node.on, outcome, {
        state: applied,
        settings: this.dependencies.settings,
      });
      return Result.ok({ state: this.changePhase(applied, next, state.phase) });
    }, this);
  }

  private async block(
    state: RunState,
    reason: string,
  ): Promise<Result<EngineResult, EngineFailure>> {
    const blocked = { ...state, blockedReason: reason };
    const saved = await this.dependencies.store.save(blocked);
    if (saved.isErr()) return saved;
    this.dependencies.events.publish({
      type: 'runBlocked',
      runId: state.runId,
      phase: state.phase,
      reason,
    });
    return Result.ok({ state: blocked, status: 'blocked', reason });
  }

  private publishRunFailed(state: RunState, reason: string): void {
    this.dependencies.events.publish({
      type: 'runFailed',
      runId: state.runId,
      phase: state.phase,
      reason,
    });
  }
}

/** A guard against a flow that never settles; every healthy pass moves a phase or a slice forward. */
const MAX_PASSES = 1000;
