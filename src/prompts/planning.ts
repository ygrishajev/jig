import type { FeaturePlan } from '../domain/run-state.js';

export function contextPrompt(request: string): string {
  return [
    'You are the context-building step of an automated SDLC pipeline.',
    'Read the following request, then explore this repository as needed to understand',
    'the relevant existing code.',
    '',
    '--- REQUEST START ---',
    request,
    '--- REQUEST END ---',
    '',
    'Produce: a one- or two-word classification of the request (e.g. "feature", "bug-fix",',
    '"refactor"), and a concise summary of the repository context relevant to it.',
    '',
    'Respond with JSON matching: { "classification": string, "repoSummary": string }.',
  ].join('\n');
}

export function featurePlanPrompt(request: string, repoSummary: string): string {
  return [
    'You are the feature-planning step of an automated SDLC pipeline.',
    '',
    '--- REQUEST ---',
    request,
    '',
    '--- REPOSITORY CONTEXT ---',
    repoSummary,
    '',
    'Produce a plan: a summary of what will change, the overall approach, and the list of',
    'affected areas of the codebase.',
    '',
    'Respond with JSON matching: { "summary": string, "approach": string, "affectedAreas": string[] }.',
  ].join('\n');
}

export function designPrompt(request: string, repoSummary: string, plan: FeaturePlan): string {
  return [
    'You are the design step of an automated SDLC pipeline.',
    'You run unattended: when you would present options to a human, evaluate 2-3 approaches,',
    'pick the recommended one, and record the alternatives with rejection rationale.',
    '',
    '--- REQUEST ---',
    request,
    '',
    '--- REPOSITORY CONTEXT ---',
    repoSummary,
    '',
    '--- PLAN SUMMARY ---',
    plan.summary,
    '',
    '--- APPROACH ---',
    plan.approach,
    '',
    'Write two markdown documents. Do not create any files — return them in your response:',
    '1. "design" with sections: Goal; Context; Chosen approach; Alternatives considered (each',
    '   with why it was rejected); Assumptions; Non-goals; Affected areas.',
    '2. "plan" — the overall implementation plan as numbered steps, each under a',
    '   `## Step N — <title>` heading, each step small enough to map onto one slice.',
    '',
    'Respond with JSON matching: { "design": string, "plan": string } (markdown in both).',
  ].join('\n');
}

export function slicePlanPrompt(planMarkdown: string): string {
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
    "A slice's title becomes its commit message when the implementer leaves work uncommitted,",
    "so write it as a one-line commit header in this repository's convention (its history and",
    'any commit-message lint config show it), at most 72 characters.',
    'Order the array the way the slices must be implemented.',
  ].join('\n');
}
