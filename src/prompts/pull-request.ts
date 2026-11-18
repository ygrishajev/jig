import { type CompletionEvidence, reusedCompletionReport } from '../domain/completion-reuse.js';
import {
  unmetRequirements,
  wholeRunFulfillment,
  wholeRunVerification,
} from '../domain/final-check.js';
import type { FeaturePlan, FinalCheckResult } from '../domain/run-state.js';
import { type Slice, slicesInOrder } from '../domain/slice.js';

export interface PullRequestPromptInput {
  template: string;
  plan: FeaturePlan;
  slices: Slice[];
  design?: string;
  verifyCommand?: string;
  finalCheck?: FinalCheckResult;
  /** The combined review's evidence the run finished on instead of a final check, if it did. */
  reusedCompletion?: CompletionEvidence;
}

export function pullRequestPrompt(input: PullRequestPromptInput): string {
  const { template, plan, slices, design, verifyCommand, finalCheck, reusedCompletion } = input;
  return [
    'You are the pull-request-description step of an automated SDLC pipeline.',
    'The work is done and committed in the current directory. Fill in the pull request',
    'template below so a human can review it without reading the agent run.',
    '',
    '--- TEMPLATE START ---',
    template,
    '--- TEMPLATE END ---',
    '',
    '--- PLAN ---',
    `Summary: ${plan.summary}`,
    `Approach: ${plan.approach}`,
    '',
    '--- SLICES ---',
    ...sliceLines(slices),
    '',
    '--- FINAL CHECK ---',
    ...finalCheckLines(finalCheck, reusedCompletion),
    ...(design ? ['', '--- DESIGN ---', design] : []),
    '',
    'Rules:',
    '- Keep every heading of the template, in order, and keep its checkboxes. Replace the',
    '  HTML comments with real content.',
    '- Write the sections that describe the result and the motivation in plain words for',
    '  someone who has not seen the code: no file paths, identifiers or technical terms.',
    '- Keep "how" or approach sections short. When a flow changed, show concise before/after',
    '  pseudocode of the decision or sequence. Explain in plain words what the new flow does',
    '  differently, when that difference matters, and why it was chosen. Base both versions',
    '  on the actual code; skip pseudocode when it adds no clarity.',
    ...verificationRule(verifyCommand),
    '- The final-check section records what the whole-run final check decided: state that',
    '  record as fact too. Put everything it reports unmet in the section for deviations.',
    '- Any slice that is not approved, a whole-run verification that failed, and any',
    '  requirement that was changed or not met goes in the section for deviations, with the',
    '  reviewer feedback in one or two lines. Write "None" there when everything landed as',
    '  planned. Do not list approved slices.',
    '- Do not add a "Closes #N" line unless the template asks for one; the pipeline appends it.',
    '- Do not paste the design or plan. A collapsed section with them is added after your text.',
    '',
    'Respond with JSON matching: { "body": string } where body is the filled-in markdown.',
  ].join('\n');
}

function sliceLines(slices: Slice[]): string[] {
  if (slices.length === 0) return ['(none)'];
  return slicesInOrder(slices).map((slice) => {
    const verification = slice.verification ? `, verify passed: ${slice.verification.command}` : '';
    const line = `- [${slice.status}${verification}] ${slice.id}: ${slice.description.split('\n')[0]}`;
    return slice.lastFeedback ? `${line}\n  reviewer feedback: ${slice.lastFeedback}` : line;
  });
}

/** The whole-run check's recorded facts, for the describer to state as fact rather than judge. */
function finalCheckLines(
  finalCheck?: FinalCheckResult,
  reusedCompletion?: CompletionEvidence,
): string[] {
  if (reusedCompletion !== undefined) {
    return reusedCompletionReport(reusedCompletion);
  }
  if (finalCheck === undefined) return ['The whole-run final check did not run.'];
  return [
    `Round completed: ${finalCheck.round}`,
    wholeRunVerification(finalCheck),
    wholeRunFulfillment(finalCheck),
    ...(finalCheck.fulfilled ? [] : unmetRequirements(finalCheck.gaps)),
  ];
}

/** The describer states jig's own verification record; it runs nothing and invents nothing. */
function verificationRule(verifyCommand?: string): string[] {
  return [
    '- Each slice line shows what jig verified: where it says "verify passed: <cmd>", jig ran',
    '  that command in the sandbox and it passed. State that record as fact. Do not run checks',
    '  yourself, and do not claim any check passed beyond what jig recorded.',
    verifyCommand
      ? `  The configured verify command is \`${verifyCommand}\`.`
      : '  No verify command is configured, so say jig ran no checks.',
  ];
}
