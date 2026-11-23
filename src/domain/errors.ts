import { TaggedError } from 'better-result';

/**
 * How the engine reacts to a failure: try the step again, stop and wait for a person, or abort
 * the run. A failure is always the failing step's own; it never becomes work for another role.
 */
export type FailureKind = 'retry' | 'block' | 'fatal';

/** A failure worth another attempt: a step, or a sandbox that did not start, gets bounded retries. */
export function isTransient(error: { kind: FailureKind }): boolean {
  return error.kind === 'retry';
}

/**
 * The planner's slices do not cover its plan. Distinct from AgentOutputInvalid so the slicing
 * step can retry exactly this failure once, with the check's diagnostics as correction feedback.
 */
export class PlanNotCovered extends TaggedError('PlanNotCovered')<{ message: string }> {
  readonly kind = 'retry' as const;
}

/**
 * The design still carries consequential findings after the planner's one revision and its
 * re-review. Only the operator can settle them, so the run stops before any slice is written.
 */
export class DesignUnresolved extends TaggedError('DesignUnresolved')<{
  message: string;
  findingIds: string[];
}> {
  readonly kind = 'block' as const;
}
