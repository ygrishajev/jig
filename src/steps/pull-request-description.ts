import {
  type CompletionEvidence,
  reusedCompletion,
  reusedCompletionReport,
} from '../domain/completion-reuse.js';
import {
  unresolvedFindings,
  wholeRunFulfillment,
  wholeRunVerification,
} from '../domain/final-check.js';
import type { FinalCheckResult, RunStateIn } from '../domain/run-state.js';
import { sliceStopReason } from '../domain/settings.js';
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
  '<!-- For reviewers: show a short before/after flow in pseudocode when behaviour changed. Explain what differs, when it matters, and why. -->',
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
 * claims; what the whole-run final check decided; the findings it left under a heading jig owns;
 * then the agent run, design and plan, collapsed.
 */
export function renderPullRequest(
  state: RunStateIn<'describing'>,
  input: { filled?: string; template?: string; verifyCommand?: string },
): string {
  const lead = input.filled ?? input.template ?? plainSummary(state);
  return [
    lead,
    verificationBlock(state.slices, input.verifyCommand),
    wholeRunBlock(state),
    ...deviationsBlock(state.finalCheck),
    collapsed('Agent run', agentRun(state)),
    ...planningDocs(state),
  ]
    .join('\n\n')
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

/**
 * What the whole-run final check decided, from the recorded result; a run that finished on its
 * combined review's evidence reports that evidence instead, and a run with neither — a legacy save
 * or a slice that got stuck before the check — reports the check as not run.
 */
function wholeRunBlock(state: RunStateIn<'describing'>): string {
  const reused = reusedCompletion(state);
  if (reused !== undefined) return reusedCompletionBlock(reused);
  return finalCheckBlock(state.finalCheck);
}

/**
 * A reused completion with its source evidence. Commits and ranges are written bare, so the forge
 * links each to the commit or comparison it names.
 */
function reusedCompletionBlock(evidence: CompletionEvidence): string {
  return [
    '### Whole-run final check (reused from the slice review)',
    '',
    ...reusedCompletionReport(evidence),
    '',
    'Source evidence:',
    `- Reviewed range: ${evidence.scope.range.start}...${evidence.scope.range.end}`,
    `- Reviewed work: commit ${evidence.checked.commit}, tree \`${evidence.checked.tree}\``,
    ...verificationSource(evidence.verification),
  ].join('\n');
}

function verificationSource(verification: CompletionEvidence['verification']): string[] {
  const at = verification?.observed?.after.host.commit;
  if (verification === undefined || at === undefined) return [];
  return [`- Verification: \`${verification.command}\` passed at commit ${at}`];
}

function finalCheckBlock(finalCheck?: FinalCheckResult): string {
  const heading =
    finalCheck === undefined
      ? '### Whole-run final check'
      : `### Whole-run final check (round ${finalCheck.round})`;
  const report =
    finalCheck === undefined
      ? 'The whole-run final check did not run.'
      : [wholeRunVerification(finalCheck), wholeRunFulfillment(finalCheck)].join('\n');
  return [heading, '', report].join('\n');
}

/** The whole-run findings under a heading jig owns, shown whatever the describer or template did. */
function deviationsBlock(finalCheck?: FinalCheckResult): string[] {
  if (finalCheck === undefined) return [];
  const findings = unresolvedFindings(finalCheck);
  if (findings.length === 0) return [];
  return [['### Deviations by jig', '', ...findings].join('\n')];
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
    const reason = slice.status === 'stuck' ? `  Stopped: ${sliceStopReason(slice)}.` : undefined;
    const entry = reason ? [line, reason] : [line];
    if (!slice.lastFeedback) return entry;
    const quoted = slice.lastFeedback
      .split('\n')
      .map((feedbackLine) => `  > ${feedbackLine}`)
      .join('\n');
    return [...entry, `  **[${slice.status}]** feedback:`, quoted];
  });
  return ['### Slices', '', ...lines].join('\n');
}

function planningDocs({ docs }: RunStateIn<'describing'>): string[] {
  return [collapsed('Design', docs.design.trim()), collapsed('Plan', docs.plan.trim())];
}
