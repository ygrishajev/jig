import { Result } from 'better-result';
import { z } from 'zod';

import {
  AgentOutputInvalid,
  type AgentRunFailed,
  CommitRejected,
  type GitCommandFailed,
} from '../domain/errors.js';
import type { Outcome } from '../domain/outcome.js';
import { protectedChanges } from '../domain/protected-paths.js';
import type { RunState } from '../domain/run-state.js';
import { type Slice, slicesInOrder } from '../domain/slice.js';
import type { SliceStep, StepPorts } from '../flow/define-flow.js';
import {
  commitRejectedFeedback,
  implementPrompt,
  nothingChangedFeedback,
  reviewPrompt,
  verifyFailedFeedback,
} from '../prompts/slice.js';

export const implementSlice: SliceStep = ({ state, slice, settings, ports }) =>
  Result.gen(async function* () {
    const { workspace } = ports;
    const attemptStart = yield* Result.await(workspace.headCommit());
    const reply = await ports.agent.runForOutput({
      role: 'implementer',
      prompt: implementPrompt(slice, settings.verifyCommand),
      schema: implementerReplySchema,
    });
    const message = yield* commitMessageOf(reply, slice);
    const approved = yield* Result.await(sliceStart(state, slice, ports));
    const saved = await workspace.saveWork(message, { approved });
    if (saved.isErr() && CommitRejected.is(saved.error)) {
      return Result.ok<Outcome>({
        type: 'changesRequested',
        feedback: commitRejectedFeedback(saved.error.output),
      });
    }
    yield* saved;
    const head = yield* Result.await(workspace.headCommit());
    if (head === approved) {
      return Result.ok<Outcome>({
        type: 'nothingChanged',
        feedback: nothingChangedFeedback(slice),
      });
    }
    const commit = yield* Result.await(workspace.summariseCommitsSince(attemptStart));
    return Result.ok<Outcome>({ type: 'implemented', commit });
  });

const implementerReplySchema = z.object({ commitMessage: z.string().trim().min(1) });

/**
 * The message for what the implementer left uncommitted. A reply jig cannot read must not cost
 * the work it describes, so the slice title stands in and the repository's hooks judge it.
 */
function commitMessageOf(
  reply: Result<z.infer<typeof implementerReplySchema>, AgentRunFailed | AgentOutputInvalid>,
  slice: Slice,
): Result<string, AgentRunFailed> {
  if (reply.isOk()) return Result.ok(reply.value.commitMessage);
  return AgentOutputInvalid.is(reply.error) ? Result.ok(slice.title) : Result.err(reply.error);
}

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
    const changed = yield* Result.await(ports.workspace.changedFilesSince(start));
    const verdict = yield* Result.await(
      ports.agent.runForOutput({
        role: 'reviewer',
        prompt: reviewPrompt(slice, `${start}..HEAD`, protectedChanges(changed)),
        schema: reviewVerdictSchema,
      }),
    );
    return Result.ok<Outcome>(outcomeOfReview(verdict));
  });

const reviewVerdictSchema = z.object({
  approved: z.boolean(),
  feedback: z.string(),
  onlyRuleFindings: z.boolean().optional(),
});

function outcomeOfReview(verdict: z.infer<typeof reviewVerdictSchema>): Outcome {
  if (verdict.approved) return { type: 'approved' };
  const type = verdict.onlyRuleFindings ? 'rulesFixRequested' : 'changesRequested';
  return { type, feedback: verdict.feedback };
}

export const verifySlice: SliceStep = async ({ settings, ports }) => {
  const command = settings.verifyCommand;
  if (!command) return Result.ok<Outcome>({ type: 'verified' });

  const ran = await ports.agent.exec(command);
  if (ran.isErr()) return Result.err(ran.error);
  const { exitCode, output } = ran.value;
  if (exitCode === 0) return Result.ok<Outcome>({ type: 'verified', command });
  return Result.ok({ type: 'changesRequested', feedback: verifyFailedFeedback(command, output) });
};
