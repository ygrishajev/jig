import { structuredOutputInstruction } from './structured-output.js';
import type { Slice } from '../state/types.js';

export function buildContextPrompt(rawRequest: string): string {
  return [
    'You are the context-building step of an automated SDLC pipeline.',
    'Read the following request, then explore this repository as needed to understand',
    'the relevant existing code.',
    '',
    '--- REQUEST START ---',
    rawRequest,
    '--- REQUEST END ---',
    '',
    'Produce: a one- or two-word classification of the request (e.g. "feature", "bug-fix",',
    '"refactor"), and a concise summary of the repository context relevant to it.',
    '',
    `Respond with JSON matching: { "classification": string, "repoSummary": string }.`,
    structuredOutputInstruction(),
  ].join('\n');
}

export function buildFeaturePlanPrompt(rawRequest: string, repoSummary: string): string {
  return [
    'You are the feature-planning step of an automated SDLC pipeline.',
    '',
    '--- REQUEST ---',
    rawRequest,
    '',
    '--- REPOSITORY CONTEXT ---',
    repoSummary,
    '',
    'Produce a plan: a summary of what will change, the overall approach, and the list of',
    'affected areas of the codebase.',
    '',
    `Respond with JSON matching: { "summary": string, "approach": string, "affectedAreas": string[] }.`,
    structuredOutputInstruction(),
  ].join('\n');
}

export function buildDesignPrompt(
  rawRequest: string,
  repoSummary: string,
  planSummary: string,
  planApproach: string,
  // Relative to the repo root, not absolute: the agent runs inside a
  // sandbox container whose filesystem doesn't have the host's absolute
  // path (e.g. a GitHub Actions runner's /home/runner/_work/...) — only a
  // path relative to its cwd (which the sandbox always bind-mounts the repo
  // root to) resolves the same way regardless of what host is driving it.
  designRelativePath: string,
  planRelativePath: string,
): string {
  return [
    'You are the design step of an automated SDLC pipeline.',
    'You run unattended: when you would present options to a human, evaluate 2-3 approaches,',
    'pick the recommended one, and record the alternatives with rejection rationale.',
    '',
    '--- REQUEST ---',
    rawRequest,
    '',
    '--- REPOSITORY CONTEXT ---',
    repoSummary,
    '',
    '--- PLAN SUMMARY ---',
    planSummary,
    '',
    '--- APPROACH ---',
    planApproach,
    '',
    'Write TWO markdown files, with paths given relative to the repository root:',
    `1. "${designRelativePath}" with sections: Goal; Context; Chosen approach; Alternatives`,
    '   considered (each with why it was rejected); Assumptions; Non-goals; Affected areas.',
    `2. "${planRelativePath}" — the overall implementation plan as numbered steps, each under a`,
    '   `## Step N — <title>` heading, each step small enough to map onto one slice.',
    '',
    'Respond with JSON matching: { "written": string[] } listing the file names you wrote.',
    structuredOutputInstruction(),
  ].join('\n');
}

export function buildSlicePlanPrompt(planMarkdown: string): string {
  return [
    'You are the PR-slicing step of an automated SDLC pipeline.',
    '',
    '--- IMPLEMENTATION PLAN ---',
    planMarkdown,
    '',
    'Break this plan into an ordered sequence of slices. Each slice becomes exactly one',
    'commit, so size slices the way you would size commits: each one a coherent, meaningful',
    'unit of work or feature delivered — never an arbitrary chunk of the diff, and never a',
    'slice carved out just to produce more than one.',
    'There is no required or minimum slice count. If the whole plan is naturally one such',
    'unit, return exactly one slice — do not split it just to produce more.',
    "Each slice must be a standalone deliverable: someone reading only that slice's commit",
    'must understand why the change exists, without knowing what comes after it.',
    'Fold prerequisite edits (type additions, builders, small refactors) into the slice that',
    'uses them — a slice that only prepares for later slices is forbidden.',
    'Only split a unit of work into more than one slice when it contains genuinely separate,',
    'independently meaningful deliverables, or when one slice would be too large for a',
    'reviewer to skim-review in about 10 minutes — in that case split along feature seams,',
    'not into bare prerequisite steps.',
    'Every slice description must start with "Implements plan step N" — the number of the',
    'plan step (from the implementation plan above) the slice delivers.',
    '',
    'Respond with JSON matching an array of:',
    '{ "id": string (kebab-case, unique), "title": string, "description": string }.',
    'Order the array the way the slices must be implemented.',
    structuredOutputInstruction(),
  ].join('\n');
}

export function buildReviewPrompt(slice: Slice): string {
  return [
    'You are the review step of an automated SDLC pipeline.',
    'Review only the most recent commit (HEAD) on this branch for the slice below — that',
    "commit is this slice's change. Earlier commits on this branch belong to already-approved",
    'slices; treat them as existing context you can rely on, not something to judge or reject.',
    '',
    `Slice: ${slice.title}`,
    `Description: ${slice.description}`,
    '',
    'Decide whether this slice is ready to merge as-is.',
    'Reject the slice if it is not a self-explanatory, standalone deliverable — for example,',
    'pure scaffolding (types, builders, refactors) for later slices with no meaningful purpose',
    'of its own; feedback must say it must be folded into the slice that consumes it.',
    'Respond with JSON matching: { "approved": boolean, "feedback": string }.',
    'If approved is false, feedback must explain exactly what needs to change.',
    structuredOutputInstruction(),
  ].join('\n');
}
