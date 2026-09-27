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
  designPath: string,
  planPath: string,
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
    'Write TWO markdown files:',
    `1. "${designPath}" with sections: Goal; Context; Chosen approach; Alternatives considered`,
    '   (each with why it was rejected); Assumptions; Non-goals; Affected areas.',
    `2. "${planPath}" — the overall implementation plan as numbered steps, each under a`,
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
    'Break this plan into an ordered sequence of small, independently reviewable slices.',
    "Each slice must be a standalone deliverable: someone reading only that slice's commit",
    'must understand why the change exists, without knowing what comes after it.',
    'Fold prerequisite edits (type additions, builders, small refactors) into the slice that',
    'uses them — a slice that only prepares for later slices is forbidden.',
    'Prefer fewer, feature-shaped slices; "small" means reviewable, never meaningless on its own.',
    'Size each slice so a reviewer can skim-review it in about 10 minutes — if a slice would',
    'take noticeably longer, split it along feature seams, not into bare prerequisite steps.',
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
    `Review the uncommitted and committed changes in this worktree for the slice below.`,
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
