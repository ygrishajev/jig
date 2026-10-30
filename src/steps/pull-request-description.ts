import type { RunStateIn } from '../domain/run-state.js';
import { slicesInOrder, type Slice } from '../domain/slice.js';

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
 * summary; followed by the agent run, design and plan, collapsed.
 */
export function renderPullRequest(
  state: RunStateIn<'describing'>,
  input: { filled?: string; template?: string },
) {
  const lead = input.filled ?? input.template ?? plainSummary(state);
  return [lead, '', collapsed('Agent run', agentRun(state)), '', ...planningDocs(state)]
    .join('\n')
    .trimEnd();
}

function plainSummary({ plan }: RunStateIn<'describing'>) {
  return ['## Summary', '', plan.summary, '', '## Approach', '', plan.approach].join('\n');
}

function agentRun({ plan, slices }: RunStateIn<'describing'>) {
  return [`**${plan.summary}**`, '', plan.approach, '', sliceChecklist(slices)].join('\n');
}

function planningDocs({ docs }: RunStateIn<'describing'>) {
  return [collapsed('Design', docs.design.trim()), '', collapsed('Plan', docs.plan.trim())];
}

function collapsed(title: string, body: string) {
  return ['<details>', `<summary>${title}</summary>`, '', body, '', '</details>'].join('\n');
}

/** A blocked run is read from here alone, so a stuck slice keeps its reviewer feedback under it. */
function sliceChecklist(slices: Slice[]) {
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
