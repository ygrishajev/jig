import type { ChangedFile } from '../domain/protected-paths.js';
import type { Slice } from '../domain/slice.js';

export function implementPrompt(slice: Slice): string {
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

function previousFeedback(slice: Slice): string[] {
  if (!slice.lastFeedback) return [];
  return [
    '',
    'A previous attempt at this slice was sent back with changes requested, by its review or by a failed check.',
    'Address this feedback specifically:',
    slice.lastFeedback,
  ];
}

export function nothingChangedFeedback(slice: Slice): string {
  return [
    'The previous attempt at this slice left the working tree unchanged, so there was nothing to review.',
    ...(slice.lastFeedback ? ['It was meant to address this feedback:', slice.lastFeedback] : []),
  ].join('\n');
}

export function commitRejectedFeedback(hookOutput: string): string {
  return [
    "The previous attempt's work is still uncommitted: this repository's commit hooks rejected",
    'the commit made for it. Fix what the hooks report, then commit the work yourself with a',
    'message they accept. Their output:',
    hookOutput,
  ].join('\n');
}

export function verifyFailedFeedback(command: string, output: string): string {
  const trimmed = output.trim();
  return [
    `The verify command \`${command}\` failed in the sandbox for this slice's commits.`,
    'Fix what it reports. Its output:',
    trimmed.length > VERIFY_OUTPUT_TAIL ? `…${trimmed.slice(-VERIFY_OUTPUT_TAIL)}` : trimmed,
  ].join('\n');
}

export const VERIFY_OUTPUT_TAIL = 3000;

/** `range` is a git revision range holding exactly this slice's commits, e.g. `<start>..HEAD`. */
export function reviewPrompt(
  slice: Slice,
  range: string,
  protectedChanges: readonly ChangedFile[],
): string {
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
    slice.verification
      ? `\`${slice.verification.command}\` passed in the sandbox for the commits in \`${range}\``
      : "no verify result is recorded (no verify command is configured) — run the project's tests and lint yourself before approving",
    ...protectedPathsSection(protectedChanges),
    '',
    'Decide whether this slice is ready to merge as-is.',
    'Reject the slice if it is not a self-explanatory, standalone deliverable — for example,',
    'pure scaffolding (types, builders, refactors) for later slices with no meaningful purpose',
    'of its own; feedback must say it must be folded into the slice that consumes it.',
    'Respond with JSON matching: { "approved": boolean, "feedback": string }.',
    'If approved is false, feedback must explain exactly what needs to change.',
  ].join('\n');
}

function protectedPathsSection(changes: readonly ChangedFile[]): string[] {
  if (changes.length === 0) return [];
  return [
    '',
    'The commits under review also touched these protected paths — tests or snapshots that already',
    'cover behaviour, and the files that decide what gets checked. Scrutinise each change for a',
    'weakened check, not only for correctness:',
    ...changes.map(({ path, kind }) => `- ${path} (${kind})`),
  ];
}
