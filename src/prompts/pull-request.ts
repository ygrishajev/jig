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
    '- Only report verification you can back up. Tick a checkbox or list a command as passed',
    `  only if you ran it here and saw it pass${verifyCommand ? ` (the pipeline's verify command is \`${verifyCommand}\`)` : ''};`,
    '  otherwise say it was not run.',
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
    const line = `- [${slice.status}] ${slice.id}: ${slice.description.split('\n')[0]}`;
    return slice.lastFeedback ? `${line}\n  reviewer feedback: ${slice.lastFeedback}` : line;
  });
}
