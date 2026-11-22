import type { Slice } from './slice.js';

/** The parts of configuration that decide how a run moves, as opposed to how it is wired. */
export interface RunSettings {
  reviewCycleCap: number;
  maxStepRetries: number;
  /** Delay before the first retry of a failed step; later retries back off exponentially. */
  retryDelayMs: number;
  designGate: 'auto' | 'checkpoint';
  mergeMode: 'auto' | 'manual';
  verifyCommand?: string;
}

export function reviewCapReached(slice: Slice, settings: RunSettings): boolean {
  return slice.reviewCycles >= settings.reviewCycleCap;
}

/** A slice still owes its verification record when a verify command is configured and it has none. */
export function sliceNeedsVerification(slice: Slice, settings: RunSettings): boolean {
  return Boolean(settings.verifyCommand) && slice.verification === undefined;
}

export function sliceStopReason(slice: Slice): string {
  if (hookFailureCapReached(slice)) return `commit hooks failed ${slice.hookFailures} times`;
  if (verificationFailureCapReached(slice))
    return `verification failed ${slice.verificationFailures} times`;
  if (emptyAttemptCapReached(slice))
    return `implementation changed nothing ${slice.emptyAttempts} times`;
  if (ruleFixCapReached(slice)) return `house-rule fixes reached the cap (${slice.ruleFixCycles})`;
  return `review rejections reached the review cap (${slice.reviewCycles})`;
}

export function hookFailureCapReached(slice: Slice): boolean {
  return slice.hookFailures >= HOOK_FAILURE_CAP;
}

/** Hook failures cannot consume the allowance reserved for reviewer findings. */
export const HOOK_FAILURE_CAP = 3;

export function verificationFailureCapReached(slice: Slice): boolean {
  return slice.verificationFailures >= VERIFICATION_FAILURE_CAP;
}

/** Verification failures cannot consume the allowance reserved for reviewer findings. */
export const VERIFICATION_FAILURE_CAP = 3;

export function emptyAttemptCapReached(slice: Slice): boolean {
  return slice.emptyAttempts >= EMPTY_ATTEMPT_CAP;
}

/**
 * An attempt that changes nothing is retried without spending a review cycle — an agent that
 * stalls once usually works on the next try — but not forever.
 */
export const EMPTY_ATTEMPT_CAP = 2;

export function ruleFixCapReached(slice: Slice): boolean {
  return slice.ruleFixCycles >= RULE_FIX_CAP;
}

/**
 * A review that finds only house-rule breaks in a slice that already works sends it back without
 * spending a review cycle, so which rules one review happened to notice does not decide whether
 * the slice gets stuck — but not forever.
 */
export const RULE_FIX_CAP = 2;
