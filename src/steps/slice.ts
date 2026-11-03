import { Result } from 'better-result';
import { z } from 'zod';

import type { GitCommandFailed } from '../domain/errors.js';
import type { Outcome } from '../domain/outcome.js';
import type { RunState } from '../domain/run-state.js';
import { type Slice, slicesInOrder } from '../domain/slice.js';
import type { SliceStep, StepPorts } from '../flow/define-flow.js';
import { implementPrompt, nothingChangedFeedback, reviewPrompt } from '../prompts/slice.js';

export const implementSlice: SliceStep = ({ state, slice, ports }) =>
  Result.gen(async function* () {
    const { workspace } = ports;
    const attemptStart = yield* Result.await(workspace.headCommit());
    yield* Result.await(ports.agent.run({ role: 'implementer', prompt: implementPrompt(slice) }));
    yield* Result.await(workspace.commitAll(`jig: implement ${slice.id} — ${slice.title}`));
    const head = yield* Result.await(workspace.headCommit());
    if (head === (yield* Result.await(sliceStart(state, slice, ports)))) {
      return Result.ok<Outcome>({
        type: 'changesRequested',
        feedback: nothingChangedFeedback(slice),
      });
    }
    const commit = yield* Result.await(workspace.summariseCommitsSince(attemptStart));
    return Result.ok<Outcome>({ type: 'implemented', commit });
  });

/**
 * Where a slice's commits begin: where the slice before it ended, or the run branch's fork point
 * for the first. Derived from approved work rather than read from HEAD, so an attempt resumed
 * after a crash still counts the commits the interrupted attempt left behind.
 */
async function sliceStart(
  state: RunState,
  slice: Slice,
  ports: StepPorts,
): Promise<Result<string, GitCommandFailed>> {
  const previousEnd = slicesInOrder(state.slices)
    .filter((candidate) => candidate.order < slice.order && candidate.commit)
    .at(-1)?.commit;
  return previousEnd ? Result.ok(previousEnd) : ports.workspace.forkPoint();
}

export const reviewSlice: SliceStep = ({ state, slice, ports }) =>
  Result.gen(async function* () {
    const start = yield* Result.await(sliceStart(state, slice, ports));
    const verdict = yield* Result.await(
      ports.agent.runForOutput({
        role: 'reviewer',
        prompt: reviewPrompt(slice, `${start}..HEAD`),
        schema: reviewVerdictSchema,
      }),
    );
    return Result.ok<Outcome>(
      verdict.approved
        ? { type: 'approved' }
        : { type: 'changesRequested', feedback: verdict.feedback },
    );
  });

const reviewVerdictSchema = z.object({ approved: z.boolean(), feedback: z.string() });

export const verifySlice: SliceStep = async ({ settings, ports }) => {
  const command = settings.verifyCommand;
  if (!command) return Result.ok<Outcome>({ type: 'verified' });

  const result = await ports.agent.exec(command);
  if (result.exitCode === 0) return Result.ok<Outcome>({ type: 'verified' });
  return Result.ok({
    type: 'changesRequested',
    feedback: `The reviewer approved this slice, but the verify command ("${command}") failed:\n${truncate(result.output.trim(), VERIFY_OUTPUT_LIMIT)}`,
  });
};

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Enough of a failing verify command's output to act on, without flooding the next prompt. */
const VERIFY_OUTPUT_LIMIT = 400;
