import type { FeaturePlan } from '../domain/run-state.js';
import { type Slice, slicesInOrder } from '../domain/slice.js';

export interface PullRequestPromptInput {
  template: string;
  plan: FeaturePlan;
  slices: Slice[];
  design?: string;
  verifyCommand?: string;
}

export function pullRequestPrompt(input: PullRequestPromptInput): string {
  const { template, plan, slices, design, verifyCommand } = input;
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
    ...(design ? ['', '--- DESIGN ---', design] : []),
    '',
    'Rules:',
    '- Keep every heading of the template, in order, and keep its checkboxes. Replace the',
    '  HTML comments with real content.',
    '- Write the sections that describe the result and the motivation in plain words for',
    '  someone who has not seen the code: no file paths, identifiers or technical terms.',
    '- Keep "how" or approach sections to a few lines on the approach and notable decisions.',
    ...verificationRule(verifyCommand),
    '- Any slice that is not approved, and any requirement that was changed or not met, goes in',
    '  the section for deviations, with the reviewer feedback in one or two lines. Write',
    '  "None" there when everything landed as planned. Do not list approved slices.',
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
