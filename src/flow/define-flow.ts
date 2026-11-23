import type { Result } from 'better-result';

import type { JigError } from '../domain/errors.js';
import type { Outcome, OutcomeType } from '../domain/outcome.js';
import type { RunPhase, RunState, RunStateIn } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { Slice, SliceStatus } from '../domain/slice.js';
import type { AgentSession } from '../ports/agent-session.js';
import type { RetryResult } from '../ports/retry.js';
import type { Workspace } from '../ports/workspace.js';

/** Each phase's node; a phase's step is typed by what that phase guarantees. */
export type RunFlow = { [P in RunPhase]: RunFlowNode<P> };

export type RunFlowNode<P extends RunPhase = RunPhase> =
  StepNode<RunPhase, RunStep<P>> | RunFinalNode | HaltNode<RunPhase> | ForEachSliceNode<RunPhase>;

export interface StepNode<S extends string, Step> {
  step: Step;
  on: Transitions<S>;
}

export type Transitions<S extends string> = Partial<Record<OutcomeType, Target<S>>>;

/** Either a fixed next state, or the first entry whose `when` holds (an entry without `when` always does). */
export type Target<S extends string> = S | ReadonlyArray<{ to: S; when?: Guard }>;

export type Guard = (context: GuardContext) => boolean;

export interface GuardContext {
  state: RunState;
  slice?: Slice;
  settings: RunSettings;
}

export type RunStep<P extends RunPhase = RunPhase> = (
  context: RunStepContext<P>,
) => Promise<Result<Outcome, JigError>>;

/** What a step in phase `P` sees: the run with everything `P` guarantees. */
export interface RunStepContext<P extends RunPhase = RunPhase> {
  state: RunStateIn<P>;
  ports: StepPorts;
  settings: RunSettings;
}

export interface StepPorts {
  agent: AgentSession;
  workspace: Workspace;
  retryResult: RetryResult;
}

/** The run ends here with `final`. */
export interface RunFinalNode {
  final: FinalOutcome;
}

/** How a run ends: merged (`done`), left for a person (`stuck`), or finished without merging (`completed`). */
export type FinalOutcome = 'done' | 'stuck' | 'completed';

/** The engine stops here; the next invocation carries on from `resumeAt`. */
export interface HaltNode<S extends string> {
  halt: true;
  resumeAt: S;
}

export interface ForEachSliceNode<S extends string> {
  forEachSlice: SliceFlow;
  on: { allApproved: S; sliceStuck: S };
}

export type SliceFlow = Record<SliceStatus, SliceFlowNode>;

export type SliceFlowNode = StepNode<SliceStatus, SliceStep> | SliceFinalNode;

export type SliceStep = (context: SliceStepContext) => Promise<Result<Outcome, JigError>>;

export interface SliceStepContext extends RunStepContext {
  slice: Slice;
}

/** A slice ends here: `done` when it succeeded, `stuck` when a person has to step in. */
export interface SliceFinalNode {
  final: 'done' | 'stuck';
}

export function defineSliceFlow(flow: SliceFlow): SliceFlow {
  return flow;
}

export function defineRunFlow(flow: RunFlow): RunFlow {
  return flow;
}

/** How the run ended, when its phase is one it never leaves; undefined while it can still move. */
export function finalStatus(flow: RunFlow, state: RunState): FinalOutcome | undefined {
  const node = flow[state.phase];
  return 'final' in node ? node.final : undefined;
}
