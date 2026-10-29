import type { Slice } from '../domain/slice.js';

export function implementPrompt(slice: Slice, baseBranch: string) {
  return [
    'You are implementing one slice of a larger, already-planned feature.',
    '',
    `Slice: ${slice.title}`,
    `Description: ${slice.description}`,
    ...previousFeedback(slice),
    '',
    'Make the necessary code changes in this repository to complete this slice.',
    'Do not commit — leave the changes in the working tree.',
    '',
    `Before you finish, check whether "${baseBranch}" has moved on since this branch was cut:`,
    `run \`git fetch origin ${baseBranch}\` and then \`git log HEAD..origin/${baseBranch}\`.`,
    `If it has, run \`git stash\`, \`git rebase origin/${baseBranch}\` and \`git stash pop\`, resolve any`,
    "conflicts so that both sides' intent survives, and re-run the checks you relied on.",
    'Still do not commit.',
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

export function reviewPrompt(slice: Slice) {
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
  ].join('\n');
}
