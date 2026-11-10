import { z } from 'zod';

import type { Outcome } from './outcome.js';
import type { FinalCheckResult, RunState } from './run-state.js';
import { type PlannedSlice, type Slice, sliceFromPlan } from './slice.js';

/** The outcome of a completed final check: what its verification did, and what the review found. */
export type FinalCheckCompletion = Extract<Outcome, { type: 'finalChecked' }>;

/** What the whole-run reviewer reports: whether the run fulfils its request, and every gap. */
export const fulfillmentVerdictSchema = z.object({
  fulfilled: z.boolean(),
  gaps: z.array(z.string()),
});

export type FulfillmentVerdict = z.infer<typeof fulfillmentVerdictSchema>;

/**
 * Folds a completed final check into the run atomically: the first failure records round 1 and
 * appends one pending repair slice; any later completion records round 2 and appends nothing, so
 * replaying a saved state can never add a second repair.
 */
export function recordFinalCheck(state: RunState, checked: FinalCheckCompletion): RunState {
  const round = state.finalCheck === undefined ? 1 : 2;
  const repaired = repairOwed(checked, round) ? withRepairSlice(state, checked) : state;
  return { ...repaired, finalCheck: completedCheck(checked, round) };
}

function repairOwed(checked: FinalCheckCompletion, round: number): boolean {
  return round === 1 && checkFailed(checked);
}

/** The one way a check fails the run, whatever caused it: verification or fulfillment. */
function checkFailed(check: { verified: boolean; fulfilled: boolean }): boolean {
  return !check.verified || !check.fulfilled;
}

function withRepairSlice(state: RunState, checked: FinalCheckCompletion): RunState {
  const repair = sliceFromPlan(repairPlan(checked, state.slices), nextOrder(state.slices));
  return { ...state, slices: [...state.slices, repair] };
}

function repairPlan(checked: FinalCheckCompletion, slices: readonly Slice[]): PlannedSlice {
  return {
    id: repairId(slices),
    title: REPAIR_TITLE,
    description: repairDescription(checked),
  };
}

function repairId(slices: readonly Slice[]): string {
  const taken = new Set(slices.map((slice) => slice.id));
  let attempt = 1;
  while (taken.has(attemptedRepairId(attempt))) attempt++;
  return attemptedRepairId(attempt);
}

function attemptedRepairId(attempt: number): string {
  return attempt === 1 ? REPAIR_ID : `${REPAIR_ID}-${attempt}`;
}

/** The repair's id base, numbered past the planned slices when it is already taken. */
const REPAIR_ID = 'final-fixes';

/** Neutral — the same title whatever the check found — and short enough for one commit subject. */
const REPAIR_TITLE = 'Address the final check findings';

function repairDescription(checked: FinalCheckCompletion): string {
  return [
    'A final check of the whole run found problems after every slice was approved.',
    'Repair exactly what this description lists; change nothing else in the approved work.',
    ...failedVerification(checked),
    ...unmetRequirements(checked.gaps),
  ].join('\n');
}

function failedVerification(checked: FinalCheckCompletion): string[] {
  if (checked.verified || checked.output === undefined) return [];
  const command = checked.command === undefined ? '' : ` \`${checked.command}\``;
  return [
    `The verify command${command} failed in the sandbox for the run branch. Its output:`,
    keepTail(checked.output, FINAL_CHECK_OUTPUT_TAIL),
  ];
}

function keepTail(text: string, limit: number): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/**
 * How much of a failed verification's output the run keeps showing: in the reviewer's prompt and
 * in the repair's description.
 */
export const FINAL_CHECK_OUTPUT_TAIL = 3000;

function unmetRequirements(gaps: string[]): string[] {
  if (gaps.length === 0) return [];
  return [
    'The review of the whole run reported these unmet requirements:',
    ...gaps.map((gap, number) => `${number + 1}. ${gap}`),
  ];
}

function nextOrder(slices: readonly Slice[]): number {
  return Math.max(-1, ...slices.map((slice) => slice.order)) + 1;
}

function completedCheck(checked: FinalCheckCompletion, round: number): FinalCheckResult {
  return {
    verified: checked.verified,
    command: checked.command,
    fulfilled: checked.fulfilled,
    gaps: checked.gaps,
    round,
  };
}

/** A failed check still owes the slices its one repair: a failure on the first round. */
export function finalCheckNeedsRepair(state: RunState): boolean {
  const result = state.finalCheck;
  return finalCheckFailed(state) && result?.round === 1;
}

/** The run's final check failed it: verification did not pass, or the request is unfulfilled. */
export function finalCheckFailed(state: RunState): boolean {
  const result = state.finalCheck;
  return result !== undefined && checkFailed(result);
}
