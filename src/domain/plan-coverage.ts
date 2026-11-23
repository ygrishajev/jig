import { Result, TaggedError } from 'better-result';

import type { PlannedSlice } from './slice.js';

type Claim = { steps: number[]; problems: string[] };

export function checkPlanCoverage(
  planMarkdown: string,
  slices: readonly PlannedSlice[],
): Result<void, PlanNotCovered> {
  const headings = stepHeadings(planMarkdown);
  const steps = [...new Set(headings.filter((step) => step > 0))].sort((a, b) => a - b);
  const claims = slices.map((slice) => claimOf(slice, steps));
  const problems = [
    ...planProblems(headings),
    ...claims.flatMap((claim) => claim.problems),
    ...coverageProblems(
      steps,
      claims.flatMap((claim) => claim.steps),
    ),
  ];
  if (problems.length === 0) return Result.ok();
  return Result.err(new PlanNotCovered({ message: problems.join('; ') }));
}

function stepHeadings(planMarkdown: string): number[] {
  return planMarkdown
    .split(/\r?\n/)
    .map((line) => STEP_HEADING.exec(line.trim())?.[1])
    .filter((step) => step !== undefined)
    .map(Number);
}

/**
 * A plan step heading, `## Step N — <title>`; the delimiter and title vary, only the number counts.
 * Other heading levels do not mark plan steps, and the number must end at a word boundary — a
 * digit run that runs on into letters, as in `## Step 1abc`, is not a step number.
 */
const STEP_HEADING = /^##\s+step\s+(\d+)\b/i;

function claimOf(slice: PlannedSlice, steps: readonly number[]): Claim {
  const reference = STEP_REFERENCE.exec(slice.description);
  if (!reference) {
    return {
      steps: [],
      problems: [
        `Slice ${slice.id} does not open its description with an "Implements plan step …" reference.`,
      ],
    };
  }
  const claimed = parseClaimedSteps(reference[1]);
  if (!claimed) {
    return {
      steps: [],
      problems: [
        `Slice ${slice.id} claims plan steps in a malformed reference: "${reference[1]}".`,
      ],
    };
  }
  const unknown = [...new Set(claimed.filter((step) => !steps.includes(step)))];
  if (unknown.length > 0) {
    return {
      steps: claimed.filter((step) => steps.includes(step)),
      problems: [
        `Slice ${slice.id} claims plan step${unknown.length > 1 ? 's' : ''} ${joinNumbers(unknown)}, which the plan does not have.`,
      ],
    };
  }
  return { steps: claimed, problems: [] };
}

/**
 * The reference a slice description opens with: the claimed steps, then a punctuation character
 * ending the reference, then whatever prose follows. The prose may span lines. A dash never ends
 * the reference — it would be indistinguishable from a range separator.
 */
const STEP_REFERENCE = /^implements\s+plan\s+steps?\s+(.+?)\s*([.:;!?—])(?:\s[\s\S]*)?$/i;

function parseClaimedSteps(reference: string): number[] | undefined {
  const items = reference
    .replace(OXFORD_CONJUNCTION, ', ')
    .replace(BARE_CONJUNCTION, ', ')
    .split(',')
    .map((item) => item.trim());
  if (items.some((item) => item === '')) return undefined;
  const claimed: number[] = [];
  for (const item of items) {
    const expanded = expandClaimedItem(item);
    if (!expanded) return undefined;
    claimed.push(...expanded);
  }
  return claimed;
}

const OXFORD_CONJUNCTION = /\s*,\s+and\s+/gi;

const BARE_CONJUNCTION = /\s+and\s+/gi;

function expandClaimedItem(item: string): number[] | undefined {
  const range = CLAIMED_RANGE.exec(item);
  if (range) return expandClaimedRange(Number(range[1]), Number(range[2]));
  const step = Number(item);
  if (!DIGITS.test(item) || !Number.isSafeInteger(step)) return undefined;
  return [step];
}

const CLAIMED_RANGE = /^(\d+)\s*[-–]\s*(\d+)$/;

function expandClaimedRange(start: number, end: number): number[] | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
  if (start > end || end - start > MAX_RANGE_SPAN) return undefined;
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

/** A range wider than any plan has steps is a mistyped reference, not a claim to count on. */
const MAX_RANGE_SPAN = 1000;

const DIGITS = /^\d+$/;

const joinNumbers = (numbers: readonly number[]): string => numbers.join(', ');

function planProblems(headings: number[]): string[] {
  if (headings.length === 0) {
    return ['The plan has no step headings for slices to implement.'];
  }
  const problems: string[] = [];
  const belowOne = headings.filter((step) => step < 1);
  if (belowOne.length > 0) {
    problems.push(`Plan step headings are numbered from 1, not ${joinNumbers(belowOne)}.`);
  }
  const duplicated = [
    ...new Set(headings.filter((step, index) => headings.indexOf(step) !== index)),
  ];
  if (duplicated.length > 0) {
    problems.push(
      `These plan step numbers have more than one heading: ${joinNumbers(duplicated)}.`,
    );
  }
  return problems;
}

function coverageProblems(steps: readonly number[], claimed: readonly number[]): string[] {
  const unimplemented = steps.filter((step) => !claimed.includes(step));
  if (unimplemented.length === 0) return [];
  return [
    `No slice implements plan step${unimplemented.length > 1 ? 's' : ''} ${joinNumbers(unimplemented)}.`,
  ];
}

/**
 * The planner's slices do not cover its plan. Distinct from AgentOutputInvalid so the slicing
 * step can retry exactly this failure once, with the check's diagnostics as correction feedback.
 */
export class PlanNotCovered extends TaggedError('PlanNotCovered')<{ message: string }> {
  readonly kind = 'retry' as const;
}
