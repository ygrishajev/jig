import type { Outcome, OutcomeType } from '../domain/outcome.js';
import type { RunPhase, RunState } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import type { Slice, SliceStatus } from '../domain/slice.js';
import type { AgentSession } from '../ports/agent-session.js';
import type { Workspace } from '../ports/workspace.js';

export interface StepPorts {
  agent: AgentSession;
  workspace: Workspace;
}

export interface RunStepContext {
  state: RunState;
  ports: StepPorts;
  settings: RunSettings;
}

export interface SliceStepContext extends RunStepContext {
  slice: Slice;
}

export type RunStep = (context: RunStepContext) => Promise<Outcome>;
export type SliceStep = (context: SliceStepContext) => Promise<Outcome>;

export interface GuardContext {
  state: RunState;
  slice?: Slice;
  settings: RunSettings;
}

export type Guard = (context: GuardContext) => boolean;

/** Either a fixed next state, or the first entry whose `when` holds (an entry without `when` always does). */
export type Target<S extends string> = S | ReadonlyArray<{ to: S; when?: Guard }>;

export type Transitions<S extends string> = Partial<Record<OutcomeType, Target<S>>>;

export interface StepNode<S extends string, Step> {
  step: Step;
  on: Transitions<S>;
}

/** The run ends here: `done` when it succeeded, `stuck` when a person has to step in. */
export interface FinalNode {
  final: 'done' | 'stuck';
}

/** The engine stops here; the next invocation carries on from `resumeAt`. */
export interface HaltNode<S extends string> {
  halt: true;
  resumeAt: S;
}

export interface ForEachSliceNode<S extends string> {
  forEachSlice: SliceFlow;
  on: { allApproved: S; sliceStuck: S };
}

export type SliceFlowNode = StepNode<SliceStatus, SliceStep> | FinalNode;

export type RunFlowNode =
  StepNode<RunPhase, RunStep> | FinalNode | HaltNode<RunPhase> | ForEachSliceNode<RunPhase>;

export type SliceFlow = Record<SliceStatus, SliceFlowNode>;
export type RunFlow = Record<RunPhase, RunFlowNode>;

export function defineSliceFlow(flow: SliceFlow) {
  return flow;
}

export function defineRunFlow(flow: RunFlow) {
  return flow;
}
