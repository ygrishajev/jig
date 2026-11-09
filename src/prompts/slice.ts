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
    ...houseRulesFirst(),
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

/**
 * Path-scoped rule files (`.claude/rules/`, `.cursor/rules/`…) load on their own only in the tool
 * they were written for; any other implementer has to be told to read them, or the reviewer
 * holds the slice to rules the implementer never saw.
 */
function houseRulesFirst(): string[] {
  return [
    "Before you change any code, read this repository's instructions for agents: AGENTS.md,",
    'CLAUDE.md or similar files at the root and in the directories you will touch, and every',
    'rule file they point to (for example under .claude/rules/) that covers a file you will create',
    'or change — tests included. Your tool may not load these on its own, so open them yourself.',
    'They are binding: the review of this slice rejects code that breaks them, even when lint',
    'passes or existing code does the same thing.',
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
    ...protectedChangesSection(protectedChanges),
    '',
    'Decide whether this slice is ready to merge as-is.',
    'Reject the slice if it is not a self-explanatory, standalone deliverable — for example,',
    'pure scaffolding (types, builders, refactors) for later slices with no meaningful purpose',
    'of its own; feedback must say it must be folded into the slice that consumes it.',
    '',
    "Judge the change against this repository's instructions for agents (AGENTS.md, CLAUDE.md or",
    'similar, and the rule files they point to) as well as the description.',
    'Review the whole range in one pass and report every problem you find, not only the first or',
    'the most serious: each rejection costs the slice one of a few attempts, so a problem you',
    'leave for the next round may be the one it runs out on. On a later round, check the whole',
    'range again, not only what the last feedback named.',
    '',
    'Respond with JSON matching: { "approved": boolean, "feedback": string }.',
    'If approved is false, feedback must list every needed change as a numbered list, each item',
    'naming the file and line and saying exactly what must change.',
  ].join('\n');
}

function protectedChangesSection(changes: readonly ChangedFile[]): string[] {
  if (changes.length === 0) return [];
  return [
    '',
    'The commits under review also changed these protected files — existing tests or check',
    'configuration. Verify ran from these same edited files, so its result covers the edited',
    'versions, not the originals:',
    ...changes.map(({ path, kind }) => `- ${path} (${kind})`),
    "For each file, confirm that the slice's description requires its change, and that the change",
    'does not weaken a check: removed or skipped tests, loosened assertions, disabled or relaxed',
    'rules, a narrower verify script or CI. If either confirmation fails for a file, reject the',
    'slice with feedback naming that file.',
  ];
}
