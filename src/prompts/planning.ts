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
    '   `## Step N — <title>` heading. Steps describe the work, not slice boundaries:',
    '   related steps may belong to one slice. Keep a coherent feature or refactor together',
    '   across its behavior, wiring, and tests instead of planning separate layers as slices.',
    '',
    'Respond with JSON matching: { "design": string, "plan": string } (markdown in both).',
  ].join('\n');
}

export function slicePlanPrompt(planMarkdown: string, correction?: string): string {
  return [
    'You are the PR-slicing step of an automated SDLC pipeline.',
    '',
    '--- IMPLEMENTATION PLAN ---',
    planMarkdown,
    '',
    'Break this plan into an ordered sequence of slices. Each slice is one reviewable outcome;',
    'implementation and review fixes may create multiple commits within that slice.',
    'Prefer vertical slices when possible: a feature should work end to end within its slice,',
    'including its behavior, wiring, and tests. For a refactor, keep the change to one coherent',
    'responsibility and its tests together. Never split work by code layer or plan step alone.',
    'There is no required or minimum slice count. If the whole plan is naturally one such',
    'unit, return exactly one slice — do not split it just to produce more.',
    'Each slice must be a standalone deliverable: its purpose must make sense without knowing',
    'what comes after it.',
    'Fold prerequisite edits (type additions, builders, small refactors) into the slice that',
    'uses them — a slice that only prepares for later slices is forbidden.',
    'Split only where both sides are independently meaningful deliverables. For each slice',
    'after the first, explain in its description why it should land separately from the',
    'preceding slice. If there is no concrete reason, combine them.',
    'Every slice description must start by naming the plan steps it delivers, from the',
    'implementation plan above: "Implements plan step 3. …" for one step, or for several',
    '"Implements plan steps 2, 4 and 5. …" — a contiguous run may be written as a range,',
    '"Implements plan steps 1-3. …". End the reference with punctuation before the prose',
    'that follows it.',
    'Slices may share plan steps, and one slice may implement every step, but together the',
    'slices must cover the whole plan: every step of the plan must be implemented by at',
    'least one slice.',
    ...correctionSection(correction),
    '',
    'Respond with JSON matching an array of:',
    '{ "id": string (kebab-case, unique), "title": string, "description": string }.',
    "A slice's title becomes its commit message when the implementer leaves work uncommitted,",
    "so write it as a one-line commit header in this repository's convention (its history and",
    'any commit-message lint config show it), at most 72 characters.',
    'Order the array the way the slices must be implemented.',
  ].join('\n');
}

function correctionSection(problems: string | undefined): string[] {
  if (!problems) return [];
  return [
    '',
    'A previous slice plan for this same implementation plan was rejected with these problems:',
    problems,
    'Respond with a complete replacement array of slices that fixes every problem — not only',
    'the slices that would change, and not the previous array with the changes described.',
  ];
}
