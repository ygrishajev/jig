import type { Slice } from '../domain/slice.js';

export function implementPrompt(slice: Slice) {
  return [
    'You are implementing one slice of a larger, already-planned feature.',
    '',
    `Slice: ${slice.title}`,
    `Description: ${slice.description}`,
    ...previousFeedback(slice),
    '',
    'Make the necessary code changes in this repository to complete this slice.',
    'Do not rebase, amend or otherwise rewrite the commits already on this branch.',
    '',
    'Before writing a script to re-derive something a tool already reported (e.g. parsing a',
    "mutation-testing or coverage tool's own output by hand), re-read what it already printed.",
    'Before re-running a slow check, check whether a later, more specific step already covers it',
    '(e.g. a full test-suite run right before a tool that re-runs the same suite itself).',
  ].join('\n');
}

function previousFeedback(slice: Slice) {
  if (!slice.lastFeedback) return [];
  return [
    '',
    'A previous attempt at this slice was reviewed and changes were requested.',
    'Address this feedback specifically:',
    slice.lastFeedback,
  ];
}

export function nothingChangedFeedback(slice: Slice) {
  return [
    'The previous attempt at this slice left the working tree unchanged, so there was nothing to review.',
    ...(slice.lastFeedback ? ['It was meant to address this feedback:', slice.lastFeedback] : []),
  ].join('\n');
}

/** `range` is a git revision range holding exactly this slice's commits, e.g. `<start>..HEAD`. */
export function reviewPrompt(slice: Slice, range: string) {
  return [
    'You are the review step of an automated SDLC pipeline.',
    `This slice's change is exactly the commits in \`${range}\` — review all of them together`,
    `(\`git log ${range}\`, \`git diff ${range}\`), including earlier attempts that a previous`,
    'review sent back. Commits before that range belong to already-approved slices; treat them',
    'as existing context you can rely on, not something to judge or reject.',
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
  ].join('\n');
}
