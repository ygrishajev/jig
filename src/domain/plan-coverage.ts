import { Result } from 'better-result';

import { AgentOutputInvalid } from './errors.js';
import type { PlannedSlice } from './slice.js';

type Claim = { steps: number[]; problems: string[] };

/**
 * Whether the slices together implement every step of the plan, each by a description that names
 * the steps it delivers. Slices may share steps and one slice may claim them all; overlapping
 * claims are how a slice spans several steps of shared work.
 */
export function checkPlanCoverage(
  planMarkdown: string,
  slices: readonly PlannedSlice[],
): Result<void, AgentOutputInvalid> {
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
  return Result.err(new AgentOutputInvalid({ message: problems.join('; ') }));
}

function stepHeadings(planMarkdown: string): number[] {
  return planMarkdown
    .split(/\r?\n/)
    .map((line) => STEP_HEADING.exec(line.trim())?.[1])
    .filter((step) => step !== undefined)
    .map(Number);
}

/** A plan step heading, `## Step N — <title>`; the delimiter and title vary, only the number counts. */
const STEP_HEADING = /^#{1,6}\s+step\s+(\d+)/i;

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
    .replace(/\s+and\s+/gi, ', ')
    .replace(/^and\s+/i, '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  const claimed: number[] = [];
  for (const item of items) {
    const range = CLAIMED_RANGE.exec(item);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end || end - start > MAX_RANGE_SPAN) return undefined;
      for (let step = start; step <= end; step += 1) claimed.push(step);
      continue;
    }
    if (!/^\d+$/.test(item)) return undefined;
    claimed.push(Number(item));
  }
  return claimed.length > 0 ? claimed : undefined;
}

/** One claimed step, or a contiguous range written `1-3`. */
const CLAIMED_RANGE = /^(\d+)\s*[-–]\s*(\d+)$/;

/** A range wider than any plan has steps is a mistyped reference, not a claim to count on. */
const MAX_RANGE_SPAN = 1000;

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
  const numbered = [...new Set(headings)].filter((step) => step > 0).sort((a, b) => a - b);
  const inOrder = numbered.every((step, index) => step === index + 1);
  if (!inOrder) {
    problems.push(
      `The plan's steps are numbered ${joinNumbers(numbered)}, not 1 through ${numbered.at(-1)} without gaps.`,
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
