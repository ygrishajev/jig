import type { RunStateIn } from '../domain/run-state.js';
import { type Slice, slicesInOrder } from '../domain/slice.js';

export const DEFAULT_PR_TEMPLATE = [
  '## What',
  '',
  '<!-- The result, in plain words: what a user or operator can do or see now. No code, paths or jargon. -->',
  '',
  '## Why',
  '',
  '<!-- The motivation, in plain words. -->',
  '',
  '## How',
  '',
  '<!-- For reviewers: the approach and the notable decisions, a few lines. -->',
  '',
  '## Verification',
  '',
  '<!-- The commands that were run and what they reported. Say what could not be run. -->',
  '',
  '## Deletions and deviations',
  '',
  '<!-- Requirements not met or changed, work left unfinished and why. Write "None" if none. -->',
].join('\n');

/**
 * The describer's filled-in template, or — when it failed — the repo's own template, or a plain
 * summary; jig's own verification report, from the recorded run state rather than the describer's
 * claims; then the agent run, design and plan, collapsed.
 */
export function renderPullRequest(
  state: RunStateIn<'describing'>,
  input: { filled?: string; template?: string; verifyCommand?: string },
): string {
  const lead = input.filled ?? input.template ?? plainSummary(state);
  return [
    lead,
    '',
    verificationBlock(state.slices, input.verifyCommand),
    '',
    collapsed('Agent run', agentRun(state)),
    '',
    ...planningDocs(state),
  ]
    .join('\n')
    .trimEnd();
}

function plainSummary({ plan }: RunStateIn<'describing'>): string {
  return ['## Summary', '', plan.summary, '', '## Approach', '', plan.approach].join('\n');
}

function verificationBlock(slices: Slice[], verifyCommand?: string): string {
  return ['### Verification by jig', '', verificationReport(slices, verifyCommand)].join('\n');
}

/** What jig itself verified, per slice from the recorded run state — never the describer's claims. */
function verificationReport(slices: Slice[], verifyCommand?: string): string {
  if (!verifyCommand) return 'No verify command is configured, so jig ran no checks.';
  const ordered = slicesInOrder(slices);
  const command = ordered[0]?.verification?.command;
  if (
    command !== undefined &&
    ordered.every((slice) => slice.status === 'approved' && slice.verification?.command === command)
  ) {
    return `\`${command}\` passed in the sandbox on every slice (${ordered.length}/${ordered.length}).`;
  }
  return ordered
    .map((slice) =>
      slice.verification
        ? `- \`${slice.id}\`: \`${slice.verification.command}\` passed`
        : `- \`${slice.id}\`: not verified (${slice.status})`,
    )
    .join('\n');
}

function collapsed(title: string, body: string): string {
  return ['<details>', `<summary>${title}</summary>`, '', body, '', '</details>'].join('\n');
}

function agentRun({ plan, slices }: RunStateIn<'describing'>): string {
  return [`**${plan.summary}**`, '', plan.approach, '', sliceChecklist(slices)].join('\n');
}

/** A blocked run is read from here alone, so a stuck slice keeps its reviewer feedback under it. */
function sliceChecklist(slices: Slice[]): string {
  const lines = slicesInOrder(slices).flatMap((slice) => {
    const line = `- [${slice.status === 'approved' ? 'x' : ' '}] ${slice.id} — ${slice.description.split('\n')[0]}`;
    if (!slice.lastFeedback) return [line];
    const quoted = slice.lastFeedback
      .split('\n')
      .map((feedbackLine) => `  > ${feedbackLine}`)
      .join('\n');
    return [line, `  **[${slice.status}]** reviewer feedback:`, quoted];
  });
  return ['### Slices', '', ...lines].join('\n');
}

function planningDocs({ docs }: RunStateIn<'describing'>): string[] {
  return [collapsed('Design', docs.design.trim()), '', collapsed('Plan', docs.plan.trim())];
}
