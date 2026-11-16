import { FINAL_CHECK_OUTPUT_TAIL } from '../domain/final-check.js';

export interface FinalCheckPromptInput {
  request: string;
  plan: string;
  range: string;
  verification?: FinalCheckVerification;
}

/** How verification went for the whole run; absent when no verify command is configured. */
export interface FinalCheckVerification {
  command?: string;
  passed: boolean;
  output?: string;
}

export function finalCheckPrompt(input: FinalCheckPromptInput): string {
  const { request, plan, range, verification } = input;
  return [
    'You are the final check of an automated SDLC pipeline.',
    'Every planned slice has been implemented, reviewed and approved. Decide whether the',
    'whole run now fulfils the original request, so its branch can be merged.',
    '',
    `The run's change is exactly the commits in \`${range}\` — review all of them together`,
    `(\`git log ${range}\`, \`git diff ${range}\`). Judge the run against the original request`,
    "and the plan below, not against the slices' individual descriptions.",
    '',
    '--- REQUEST START ---',
    request,
    '--- REQUEST END ---',
    '',
    '--- PLAN START ---',
    plan,
    '--- PLAN END ---',
    '',
    ...verificationSection(verification, range),
    'Do not run mutation testing as a side effect of review.',
    '',
    'Report every requirement of the request or the plan that the run leaves unmet, incomplete',
    'or broken — a gap — in one pass, not only the first or the most serious. Use focused',
    'checks to investigate a specific concern.',
    '',
    'Respond with JSON matching: { "fulfilled": boolean, "gaps": string[] }.',
    'Set fulfilled to true only when the run fulfils the request as planned. List every gap,',
    'each saying exactly what is unmet or wrong; use an empty list when nothing is.',
  ].join('\n');
}

function verificationSection(
  verification: FinalCheckVerification | undefined,
  range: string,
): string[] {
  if (verification?.command === undefined) {
    return [
      'No verify command is configured: use focused checks for the changed files before deciding.',
      'Report what you checked and any remaining verification gaps.',
    ];
  }
  if (verification.passed) {
    return [
      `The verify command \`${verification.command}\` passed in the sandbox for \`${range}\`.`,
      'jig owns full verification. Do not rerun the verify command or run a broader check',
      '(including the same script without its arguments or a suite it skips), even when the request or repository',
      'instructions ask for it. Use focused checks to investigate a specific concern.',
    ];
  }
  return [
    `The verify command \`${verification.command}\` failed in the sandbox for \`${range}\`. Its output:`,
    keepTail(verification.output ?? '', FINAL_CHECK_OUTPUT_TAIL),
    'jig owns full verification. Do not rerun the verify command or run a broader check',
    '(including the same script without its arguments or a suite it skips), even when the request or',
    'repository instructions ask for it. Use focused checks to investigate the recorded failure.',
  ];
}

function keepTail(text: string, limit: number): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}
