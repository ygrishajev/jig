import { structuredOutputInstruction } from './structured-output.js';

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

export function buildSlicePlanPrompt(planSummary: string, planApproach: string): string {
  return [
    'You are the PR-slicing step of an automated SDLC pipeline.',
    '',
    '--- PLAN SUMMARY ---',
    planSummary,
    '',
    '--- APPROACH ---',
    planApproach,
    '',
    'Break this plan into an ordered sequence of small, independently reviewable slices.',
    'Each slice must be implementable and mergeable on its own, in the given order.',
    '',
    'Respond with JSON matching an array of:',
    '{ "id": string (kebab-case, unique), "title": string, "description": string }.',
    'Order the array the way the slices must be implemented.',
    structuredOutputInstruction(),
  ].join('\n');
}
