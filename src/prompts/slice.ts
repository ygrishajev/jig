import type { ChangedFile } from '../domain/protected-paths.js';
import { earlierFeedback, type Slice } from '../domain/slice.js';

export interface CombinedReviewInput {
  slice: Slice;
  range: string;
  protectedChanges: readonly ChangedFile[];
  request: string;
  plan: string;
}

export function implementPrompt(slice: Slice, verifyCommand?: string): string {
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
    'Preserve lint, test and verification settings. Change them only when this slice explicitly',
    'requires the change; never relax a check to make the implementation pass.',
    'Do not rebase, amend or otherwise rewrite the commits already on this branch.',
    '',
    ...checkAgainstHouseRulesLast(),
    '',
    ...commitMessageReply(),
    '',
    'Before writing a script to re-derive something a tool already reported (e.g. parsing a',
    "mutation-testing or coverage tool's own output by hand), re-read what it already printed.",
    'Before re-running a slow check, check whether a later, more specific step already covers it',
    '(e.g. a full test-suite run right before a tool that re-runs the same suite itself).',
    '',
    ...verificationGuidance(verifyCommand),
    'Do not run mutation testing as a side effect of implementation or review.',
  ].join('\n');
}

function previousFeedback(slice: Slice): string[] {
  if (!slice.lastFeedback) return [];
  return [
    '',
    'A previous attempt at this slice was sent back with changes requested, by its review or by a failed check.',
    'Address this feedback specifically:',
    slice.lastFeedback,
    'If a requested change is wrong or outside this slice, check the relevant code and request',
    'before disputing it. Record the evidence in your commit message body so the reviewer can',
    'verify it from the commit history.',
    'Do not leave a supported finding unresolved because you disagree with its wording.',
    ...earlierRounds(slice),
  ];
}

function earlierRounds(slice: Slice): string[] {
  const rounds = earlierFeedback(slice);
  if (rounds.length === 0) return [];
  return [
    '',
    'Earlier rounds of this slice were sent back with this feedback:',
    ...rounds.map((feedback, round) => roundSection(feedback, round)),
    '',
    'If the latest feedback reports a problem an earlier round already reported, the previous fix',
    'did not work: find out why before changing code again, and take a different approach rather',
    'than adjusting the same one.',
  ];
}

function roundSection(feedback: string, round: number): string {
  return `Round ${round + 1}:\n${keepTail(feedback, EARLIER_FEEDBACK_LIMIT)}`;
}

function keepTail(text: string, limit: number): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/** An earlier round is history, not the task: cap each one so old rounds cannot drown the latest. */
export const EARLIER_FEEDBACK_LIMIT = 3000;

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

/** A review that finds a rule the implementer could have checked costs the slice a whole attempt. */
function checkAgainstHouseRulesLast(): string[] {
  return [
    'Before you finish, review your own change the way the reviewer will: read your whole diff',
    '(your commits on this branch and anything uncommitted) and, for each rule file that covers a',
    'changed file, go through it rule by rule. Fix every place your change breaks one.',
  ];
}

function commitMessageReply(): string[] {
  return [
    'When you are done, reply with { "commitMessage": string }: the commit message for your',
    'change. Whatever you leave uncommitted is committed with it, so write it in this',
    "repository's commit convention (its history and any commit-message lint config show it): a",
    'one-line header that says what changed, then a body that says why.',
    'Jig uses the returned text as the commit message. Keep hook output, retry instructions,',
    'and notes about editing the message out of both this reply field and any commits you make.',
  ];
}

function verificationGuidance(verifyCommand?: string): string[] {
  if (!verifyCommand) {
    return [
      'No verify command is configured: use focused tests and lint for the changed files before finishing.',
      'Report what you checked and any remaining verification gaps.',
    ];
  }
  return [
    `jig runs full verification with \`${verifyCommand}\` once you finish and records the result`,
    'for review. Use focused checks (one spec file, lint on changed files) while you work.',
    'Do not run the full verify command or a broader check, including the same script without',
    'its arguments or a suite it skips, even if the request or repository instructions ask for it.',
    'Use any recorded verification failure in the feedback above to choose what to fix and check.',
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
    "The previous attempt's work is still uncommitted because a repository commit hook rejected it.",
    'If the hook only rejected the message, leave the pending changes intact and return a corrected',
    'commitMessage. Jig will retry the commit through the same hooks.',
    'If the hook reported a problem with the pending changes, fix those changes before committing',
    'them or returning a commitMessage for Jig to commit them.',
    'Use the hook output below to make the correction. Keep it and any instructions for correcting',
    'the message out of the commit history.',
    '',
    'Hook output:',
    hookOutput,
  ].join('\n');
}

export function verifyFailedFeedback(command: string, output: string): string {
  const trimmed = output.trim();
  return [
    `The verify command \`${command}\` failed in the sandbox for this slice's commits.`,
    'Fix what it reports. Its output:',
    keepTail(trimmed, VERIFY_OUTPUT_TAIL),
  ].join('\n');
}

export const VERIFY_OUTPUT_TAIL = 3000;

/** `range` is a git revision range holding exactly this slice's commits, e.g. `<start>..HEAD`. */
export function reviewPrompt(
  slice: Slice,
  range: string,
  protectedChanges: readonly ChangedFile[],
): string {
  return [...sliceReviewSections(slice, range, protectedChanges), ...reviewReplyFormat()].join(
    '\n',
  );
}

/** What every slice review covers, shared by the ordinary one and the combined one. */
function sliceReviewSections(
  slice: Slice,
  range: string,
  protectedChanges: readonly ChangedFile[],
): string[] {
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
      : 'No verify result is recorded (no verify command is configured). Use focused tests and lint',
    ...(slice.verification
      ? [
          'jig owns full verification. Do not rerun the verify command or run a broader check',
          '(including the same script without its arguments or a suite it skips), even when the request or repository',
          'instructions ask for it. Judge this recorded result alongside the diff; use focused',
          'checks to investigate a specific concern and report any remaining verification gaps.',
        ]
      : ['for the changed files and report what you checked and any remaining verification gaps.']),
    'Do not run mutation testing as a side effect of review.',
    ...protectedChangesSection(protectedChanges),
    '',
    'Decide whether this slice is ready to merge as-is.',
    'Reject the slice if it is not a self-explanatory, standalone deliverable — for example,',
    'pure scaffolding (types, builders, refactors) for later slices with no meaningful purpose',
    'of its own; feedback must say it must be folded into the slice that consumes it.',
    '',
    "Judge the change against the description and against this repository's instructions for",
    'agents (AGENTS.md, CLAUDE.md or similar, and the rule files they point to). For the rules,',
    'find every rule file that covers a file the range changes, tests included, and go through',
    'each one rule by rule against the diff — not a general read with the rules in mind. A rule',
    'broken in many places is reported at each place.',
    'Review the whole range in one pass and report every problem you find, not only the first or',
    'the most serious: each rejection costs the slice one of a few attempts, so a problem you',
    'leave for the next round may be the one it runs out on. On a later round, check the whole',
    'range again, not only what the last feedback named.',
    'For a missing edge case, name the reachable input or state, the wrong result, and why',
    'existing checks do not cover it. Do not request coverage for a speculative case that',
    'the slice cannot reach.',
    "If an earlier finding was disputed, check the implementer's evidence against the code.",
    'Drop the finding when that evidence holds; otherwise explain the remaining failure case.',
  ];
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

function reviewReplyFormat(): string[] {
  return [
    '',
    'Respond with JSON matching:',
    '{ "approved": boolean, "feedback": string, "onlyRuleFindings": boolean }.',
    ...codeVerdictInstructions(),
  ];
}

function codeVerdictInstructions(): string[] {
  return [
    'If approved is false, feedback must list every needed change as a numbered list, each item',
    'naming the file and line and saying exactly what must change.',
    'Set onlyRuleFindings to true only when the slice already does everything its description',
    "asks, correctly, and every needed change is a fix to follow the repository's rules (style,",
    'naming, test conventions, error handling conventions). Set it to false when anything is',
    'missing, wrong in behaviour, or untested, and whenever you approve.',
  ];
}

/**
 * The review of a run whose single slice is its whole change: everything the slice review asks,
 * plus the original request and its plan, so one review can vouch for the whole run.
 */
export function combinedReviewPrompt(input: CombinedReviewInput): string {
  return [
    ...sliceReviewSections(input.slice, input.range, input.protectedChanges),
    ...wholeRequestSections(input),
    ...combinedReplyFormat(),
  ].join('\n');
}

/** The whole request a combined review also judges, with the plan it was planned against. */
function wholeRequestSections({ request, plan }: CombinedReviewInput): string[] {
  return [
    '',
    "This slice is the run's only slice, so those same commits are the whole run's change: also",
    'decide whether the whole run fulfils the original request, so its branch can be merged.',
    'Judge the whole change against the request and the plan below, not only against the slice',
    'description.',
    '',
    '--- REQUEST START ---',
    request,
    '--- REQUEST END ---',
    '',
    '--- PLAN START ---',
    plan,
    '--- PLAN END ---',
    '',
    'Report every requirement of the request or the plan that the run leaves unmet, incomplete',
    'or broken — a gap — in the same pass, not only the first or the most serious. Use focused',
    'checks to investigate a specific concern.',
  ];
}

function combinedReplyFormat(): string[] {
  return [
    '',
    'Respond with JSON matching:',
    '{ "approved": boolean, "feedback": string, "onlyRuleFindings": boolean,',
    '  "fulfilled": boolean, "gaps": string[] }.',
    ...codeVerdictInstructions(),
    'Set fulfilled to true only when the whole run fulfils the request as planned. List every',
    'gap, each saying exactly what is unmet or wrong; use an empty list when nothing is.',
    'Decide the two verdicts independently: report the request and its gaps whatever you decide',
    'about the code, and judge the code whatever the request still misses.',
  ];
}
