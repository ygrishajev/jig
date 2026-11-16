import { createHash } from 'node:crypto';
import { z } from 'zod';

import { type FulfillmentVerdict, fulfillmentVerdictSchema } from './final-check.js';
import type { RunState } from './run-state.js';
import type { RunSettings } from './settings.js';
import {
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
  /** The verify command the recorded verification ran; undefined when none is configured. */
  command: z.string().min(1).optional(),
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
    range: z.string().min(1),
  }),
});

export type CompletionEvidence = z.infer<typeof completionEvidenceSchema>;

/**
 * The evidence a combined review leaves, bound to what it actually saw: the resulting work, the
 * digests of the request and plan it judged, and the settings it ran under.
 */
export function completionEvidenceOf(input: {
  reviewed: WholeRequest;
  settings: RunSettings;
  command: string | undefined;
  verdict: FulfillmentVerdict;
  observed: WorkObservations;
  range: string;
}): CompletionEvidence {
  const { reviewed, settings, command, verdict, observed, range } = input;
  return {
    verdict,
    command,
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
  return digestOf(canonicalJson(settings));
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** JSON with recursively sorted keys, so the same value always serializes the same way. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`).join(',')}}`;
}

/**
 * Whether the recorded whole-request review still stands for the work the run now holds: the same
 * commit and tree, clean on both sides, judged against the same request, plan and settings, with
 * nothing left unfulfilled and nothing mutated since. Anything else asks for a fresh final check.
 */
export function completionStillReusable(
  state: RunState,
  observed: WorkFacts,
  settings: RunSettings,
): boolean {
  const evidence = state.completionReuse;
  if (evidence === undefined) return false;
  return (
    verdictStands(evidence.verdict) &&
    evidence.settingsIdentity === settingsIdentityOf(settings) &&
    sourcesStillHold(evidence, state) &&
    workStillHolds(evidence, observed) &&
    observedCleanly(evidence.observed)
  );
}

/** The recorded verdict must have found the request fulfilled, with no gap left open. */
function verdictStands(verdict: FulfillmentVerdict): boolean {
  return verdict.fulfilled && verdict.gaps.length === 0;
}

/** The sources the review judged are still the ones the run holds. */
function sourcesStillHold(evidence: CompletionEvidence, state: RunState): boolean {
  return (
    evidence.scope.request === digestOf(state.request) &&
    state.docs !== undefined &&
    evidence.scope.plan === digestOf(state.docs.plan)
  );
}

/** The work the review vouched for is the work the run still holds, clean on both sides of it. */
function workStillHolds(evidence: CompletionEvidence, observed: WorkFacts): boolean {
  return (
    evidence.checked.commit === observed.host.commit &&
    evidence.checked.tree === observed.host.tree &&
    observed.sandbox.commit === observed.host.commit &&
    observed.host.clean &&
    observed.sandbox.clean
  );
}

/** The review must have run on clean work that stayed exactly where it was until it ended. */
function observedCleanly(observed: WorkObservations): boolean {
  const { before, after } = observed;
  return (
    factsIdentity(before) === factsIdentity(after) && before.host.clean && before.sandbox.clean
  );
}

/** Where the work stood, as one comparable value: key order cannot make two facts look different. */
function factsIdentity(facts: WorkFacts): string {
  return canonicalJson(facts);
}
