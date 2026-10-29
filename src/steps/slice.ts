import { z } from 'zod';
import type { Slice } from '../domain/slice.js';
import type { SliceStep } from '../flow/define-flow.js';
import { implementPrompt, nothingChangedFeedback, reviewPrompt } from '../prompts/slice.js';

const reviewVerdictSchema = z.object({ approved: z.boolean(), feedback: z.string() });

/** Enough of a failing verify command's output to act on, without flooding the next prompt. */
const VERIFY_OUTPUT_LIMIT = 400;

export const implementSlice: SliceStep = async ({ slice, ports }) => {
  const startCommit = slice.startCommit ?? (await ports.workspace.headCommit());
  await ports.agent.run({ role: 'implementer', prompt: implementPrompt(slice) });
  const commit = await ports.workspace.commitAll(`sdlc: implement ${slice.id} — ${slice.title}`);
  if (!commit) return { type: 'changesRequested', feedback: nothingChangedFeedback(slice) };
  return { type: 'implemented', startCommit, commit };
};

export const reviewSlice: SliceStep = async ({ slice, ports }) => {
  const verdict = await ports.agent.runForOutput({
    role: 'reviewer',
    prompt: reviewPrompt(slice, reviewRange(slice)),
    schema: reviewVerdictSchema,
  });
  return verdict.approved
    ? { type: 'approved' }
    : { type: 'changesRequested', feedback: verdict.feedback };
};

export const verifySlice: SliceStep = async ({ settings, ports }) => {
  const command = settings.verifyCommand;
  if (!command) return { type: 'verified' };

  const result = await ports.agent.exec(command);
  if (result.exitCode === 0) return { type: 'verified' };
  return {
    type: 'changesRequested',
    feedback: `The reviewer approved this slice, but the verify command ("${command}") failed:\n${truncate(result.output.trim(), VERIFY_OUTPUT_LIMIT)}`,
  };
};

/** A slice saved before slices recorded their start is reviewed the old way: its latest commit only. */
function reviewRange(slice: Slice) {
  return slice.startCommit ? `${slice.startCommit}..HEAD` : 'HEAD~1..HEAD';
}

function truncate(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
