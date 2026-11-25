import { createHash } from 'node:crypto';
import stringify from 'safe-stable-stringify';
import { z } from 'zod';

import { type FulfillmentVerdict, fulfillmentVerdictSchema } from './final-check.js';
import type { RunState } from './run-state.js';
import type { RunSettings } from './settings.js';
import { type Slice, verificationRecordSchema } from './slice.js';
import {
  type CheckedWork,
  checkedWorkSchema,
  type WorkFacts,
  type WorkObservations,
  workObservationsSchema,
} from './work-facts.js';

/** The whole request an eligible slice review also judges: the run's original request and its plan. */
export interface WholeRequest {
  request: string;
  plan: string;
}

/**
 * A sha256 digest, as hex: how recorded evidence binds itself to the exact sources and settings
 * it saw without repeating them.
 */
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What a combined slice review recorded about the whole request, bound to the exact work, sources
 * and settings it saw — the run's evidence for reusing that review as its completion check.
 */
export const completionEvidenceSchema = z.object({
  /** The reviewer's judgement of the whole request: whether the run fulfils it, and every gap. */
  verdict: fulfillmentVerdictSchema,
  /** The complete verification the reviewed work passed under; undefined when none is recorded. */
  verification: verificationRecordSchema.optional(),
  /** Digest of the settings the review ran under; a different digest means the evidence no longer applies. */
  settingsIdentity: digestSchema,
  /** The exact resulting work the review vouches for: the run branch's commit and its tree. */
  checked: checkedWorkSchema,
  /** Where the work stood before and after the review; a difference is mutation during it. */
  observed: workObservationsSchema,
  /** The sources the review judged, by digest, and the full run range it read them against. */
  scope: z.object({
    request: digestSchema,
    plan: digestSchema,
    range: z.object({ start: z.string().min(1), end: z.string().min(1) }),
  }),
});

export type CompletionEvidence = z.infer<typeof completionEvidenceSchema>;

/**
 * The evidence a combined review leaves, bound to what it actually saw: the resulting work, the
 * verification that passed under it, the digests of the request and plan it judged, and the
 * settings it ran under.
 */
export function completionEvidenceOf(input: {
  reviewed: WholeRequest;
  settings: RunSettings;
  verification: Slice['verification'];
  verdict: FulfillmentVerdict;
  observed: WorkObservations;
  range: { start: string; end: string };
}): CompletionEvidence {
  const { reviewed, settings, verification, verdict, observed, range } = input;
  return {
    verdict,
    verification,
    settingsIdentity: settingsIdentityOf(settings),
    checked: {
      commit: observed.after.host.commit,
      tree: observed.after.host.tree,
    },
    observed,
    scope: {
      request: digestOf(reviewed.request),
      plan: digestOf(reviewed.plan),
      range,
    },
  };
}

/** How the settings a review ran under are identified, so a later check can see they did not change. */
export function settingsIdentityOf(settings: RunSettings): string {
  return digestOf(stringify(settings));
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Whether the recorded whole-request review still stands for the work the run now holds: the run
 * is still the eligible single approved slice the review judged, the verification the work passed
 * still matches the configured command and the checked work, the review ran on both repositories
 * clean and unmoving at exactly that work, and the work the run holds is still that work. Anything
 * else asks for a fresh final check.
 */
export function completionStillReusable(
  state: RunState,
  observed: WorkFacts,
  settings: RunSettings,
  forkPoint: string,
): boolean {
  const evidence = state.completionReuse;
  if (evidence === undefined || !completionReuseInPlay(state, settings)) return false;
  return (
    scopeStillHolds(evidence, forkPoint) &&
    factsVouchFor(observed, evidence.checked) &&
    observationsVouchFor(evidence.observed, evidence.checked)
  );
}

/**
 * Whether the run's own record still offers its evidence for reuse, before the work is observed:
 * an eligible approved run, a standing verdict, unchanged sources and settings, and a verification
 * that passed at the checked work. A run that offers none needs no observation to be declined.
 */
export function completionReuseInPlay(state: RunState, settings: RunSettings): boolean {
  const evidence = state.completionReuse;
  return (
    evidence !== undefined &&
    reviewStillEligible(state) &&
    verdictStands(evidence.verdict) &&
    settingsStillHold(evidence, state, settings) &&
    verificationStillHolds(evidence, settings)
  );
}

/** The run is still what a combined review can vouch for: one slice, no final check yet, that slice approved. */
function reviewStillEligible(state: RunState): boolean {
  return wholeRequestOf(state) !== undefined && state.slices[0].status === 'approved';
}

/**
 * The whole request this run's slice review can also judge, when its single slice is the run's
 * whole work. Undefined for any other run: one whose final check already ran, whose review would
 * cover a repair, or whose plan never reached it.
 */
export function wholeRequestOf(state: RunState): WholeRequest | undefined {
  if (state.slices.length !== 1) return undefined;
  if (state.finalCheck !== undefined) return undefined;
  const docs = state.docs;
  if (docs === undefined) return undefined;
  return { request: state.request, plan: docs.plan };
}

/** The recorded verdict must have found the request fulfilled, with no gap left open. */
function verdictStands(verdict: FulfillmentVerdict): boolean {
  return verdict.fulfilled && verdict.gaps.length === 0;
}

/** The settings and the sources the review judged are still the ones the run holds. */
function settingsStillHold(
  evidence: CompletionEvidence,
  state: RunState,
  settings: RunSettings,
): boolean {
  return (
    evidence.settingsIdentity === settingsIdentityOf(settings) && sourcesStillHold(evidence, state)
  );
}

/** The sources the review judged are still the ones the run holds. */
function sourcesStillHold(evidence: CompletionEvidence, state: RunState): boolean {
  return (
    evidence.scope.request === digestOf(state.request) &&
    state.docs !== undefined &&
    evidence.scope.plan === digestOf(state.docs.plan)
  );
}

/**
 * The verification the review relied on: the now-configured command is the one that passed, and
 * the work it ran on is exactly the work the review checked, clean and unmoving on both sides.
 */
function verificationStillHolds(evidence: CompletionEvidence, settings: RunSettings): boolean {
  const verification = evidence.verification;
  return (
    verification !== undefined &&
    verification.command === settings.verifyCommand &&
    observationsVouchFor(verification.observed, evidence.checked)
  );
}

/** Both sides of the recorded work stood exactly at the checked work, clean, before an operation as after it. */
function observationsVouchFor(observed: WorkObservations, checked: CheckedWork): boolean {
  return (
    factsIdentity(observed.before) === factsIdentity(observed.after) &&
    factsVouchFor(observed.before, checked)
  );
}

/** Where the work stood, as one comparable value: key order cannot make two facts look different. */
function factsIdentity(facts: WorkFacts): string {
  return stringify(facts);
}

/** A repository pair vouches for the checked work when both hold exactly that commit and tree, clean. */
function factsVouchFor(facts: WorkFacts, checked: CheckedWork): boolean {
  return (
    facts.host.commit === checked.commit &&
    facts.host.tree === checked.tree &&
    facts.sandbox.commit === checked.commit &&
    facts.sandbox.tree === checked.tree &&
    facts.host.clean &&
    facts.sandbox.clean
  );
}

/** The recorded range is still the run's whole range: it starts where the run was cut and ends at the checked work. */
function scopeStillHolds(evidence: CompletionEvidence, forkPoint: string): boolean {
  return (
    evidence.scope.range.start === forkPoint && evidence.scope.range.end === evidence.checked.commit
  );
}

/** The evidence the run was authorized to finish on in place of a final check; undefined when it finishes otherwise. */
export function reusedCompletion(state: RunState): CompletionEvidence | undefined {
  return state.completionReuseAuthorized ? state.completionReuse : undefined;
}

export function completionReuseWasAuthorized(state: RunState): boolean {
  return state.completionReuseAuthorized === true;
}

/** How jig states a reused completion: what the combined review decided, and the verification it relied on. */
export function reusedCompletionReport(evidence: CompletionEvidence): string[] {
  const verification = evidence.verification;
  return [
    "jig ran no separate final check: the review of the run's single slice judged the whole request against its plan and reported it fulfilled.",
    ...(verification === undefined
      ? []
      : [
          `The verify command \`${verification.command}\` passed in the sandbox on exactly the reviewed work.`,
        ]),
  ];
}
